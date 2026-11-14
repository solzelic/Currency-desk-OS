import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { migrations, runMigrations, type Migration } from "../src/db/migrations.js";
import { createSession } from "../src/auth/sessions.js";
import { buildApp } from "../src/app.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import type { LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const migration: Migration = ["074_legal_entity_timezone", "src/db/migrations/074_legal_entity_timezone.sql"];
const zoneModule = () => import("../src/ledger/entity-zone.js");
const TORONTO = "America/Toronto";
const JERUSALEM = "Asia/Jerusalem";
const VANCOUVER = "America/Vancouver";
const roles = ["administrator", "branch_manager", "supervisor", "teller", "compliance_officer", "auditor"] as const;

describe("embedded entity-zone schema", () => {
  it("has a nullable column and rejects blank settings without SQL migration boot", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_MEMORY", "1");
    let handle: DbHandle | undefined;
    try {
      handle = await createDb();
      await handle.db.execute(sql`INSERT INTO tenants(id,name) VALUES ('zone-embedded','Synthetic')`);
      await handle.db.execute(sql`INSERT INTO legal_entities(id,tenant_id,name) VALUES ('zone-embedded','zone-embedded','Synthetic')`);
      expect((await handle.db.execute(sql`SELECT timezone FROM legal_entities WHERE id='zone-embedded'`)).rows[0]).toEqual({ timezone: null });
      await expect(handle.db.execute(sql`UPDATE legal_entities SET timezone='   ' WHERE id='zone-embedded'`)).rejects.toThrow();
    } finally {
      await handle?.close();
      vi.unstubAllEnvs();
    }
  }, 30_000);
});

postgres("shop report zone on PostgreSQL", () => {
  let pool: pg.Pool;
  let handle: DbHandle;
  let app: FastifyInstance;
  let entity: string;
  let tenant: string;
  let branch: string;
  let workspace: string;
  let cookies: Record<string, { cdos_session: string }>;
  let owner: LedgerActor;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!);
    vi.stubEnv("LEDGER_DATABASE_URL", url!);
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 1000 });
    app = await buildApp(handle.db);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await pool?.end();
    vi.unstubAllEnvs();
  });
  beforeEach(async () => {
    const suffix = randomUUID();
    tenant = `zone-tenant-${suffix}`;
    entity = `zone-entity-${suffix}`;
    branch = `zone-branch-${suffix}`;
    workspace = `zone-workspace-${suffix}`;
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Synthetic zone shop')", [tenant]);
    await pool.query("INSERT INTO legal_entities(id,tenant_id,name) VALUES ($1,$2,'Synthetic zone entity')", [entity, tenant]);
    await pool.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name,created_at) VALUES ($1,$2,$3,'First branch','2020-01-01')", [branch, tenant, entity]);
    await pool.query("INSERT INTO workspaces(id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$4,'zone-till')", [workspace, tenant, entity, branch]);
    cookies = {};
    for (const role of roles) {
      const userId = `${suffix}-${role}`;
      await pool.query(`INSERT INTO staff_users(id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash)
        VALUES ($1,$2,$3,$4,$1,'Synthetic staff',$5,$6,'not-a-login-hash')`, [userId, tenant, entity, branch, role, JSON.stringify([branch])]);
      const session = await createSession(handle.db, userId);
      cookies[role] = { cdos_session: session.token };
      if (role === "administrator") owner = { userId, tenantId: tenant, legalEntityId: entity, branchId: branch, workspaceId: workspace, tillId: "zone-till", role, authorizedBranchIds: [branch] };
    }
    await ensureLedgerPrincipal(pool, owner);
  });

  const get = (role = "administrator", headers = {}) => app.inject({ method: "GET", url: "/api/ledger/entity-zone", cookies: cookies[role], headers });
  const put = (payload: object, role = "administrator", headers = {}) => app.inject({ method: "PUT", url: "/api/ledger/entity-zone", payload, cookies: cookies[role], headers });
  const audits = async () => (await pool.query("SELECT * FROM ledger_audit_events WHERE legal_entity_id=$1 AND action='entity_timezone.change' ORDER BY created_at,event_id", [entity])).rows;
  const stored = async () => (await pool.query("SELECT timezone FROM legal_entities WHERE id=$1", [entity])).rows[0].timezone;
  async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      return await run(client);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }

  it("registers the migration and installs a nullable no-default column with a working check on fresh boot", async () => {
    expect(migrations).toContainEqual(migration);
    expect(await stored()).toBeNull();
    const column = (await pool.query("SELECT is_nullable,column_default,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='legal_entities' AND column_name='timezone'")).rows[0];
    expect(column).toEqual({ is_nullable: "YES", column_default: null, data_type: "text" });
    await expect(pool.query("UPDATE legal_entities SET timezone='   ' WHERE id=$1", [entity])).rejects.toMatchObject({ code: "23514" });
  });

  it("upgrades synthetic legacy rows without changing any field and safely replays", async () => {
    const namespace = `zone_legacy_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA ${namespace}`);
    const legacy = new pg.Pool({ connectionString: url, options: `-c search_path=${namespace}`, max: 1 });
    try {
      await legacy.query("CREATE TABLE legal_entities(id text PRIMARY KEY,tenant_id text,name text,created_at timestamptz); INSERT INTO legal_entities VALUES ('legacy','legacy-tenant','Legacy synthetic','2020-02-03')");
      const before = (await legacy.query("SELECT to_jsonb(e) AS row FROM legal_entities e")).rows[0].row;
      await runMigrations(legacy, [migration]);
      expect((await legacy.query("SELECT to_jsonb(e) AS row FROM legal_entities e")).rows[0].row).toEqual({ ...before, timezone: null });
      await legacy.query("UPDATE legal_entities SET timezone='Asia/Jerusalem'");
      await runMigrations(legacy, [migration]);
      // An existing column alone must not suppress installation of the check.
      await legacy.query("ALTER TABLE legal_entities DROP CONSTRAINT legal_entities_timezone_nonblank");
      await legacy.query(await readFile(migration[1], "utf8"));
      expect((await legacy.query("SELECT to_jsonb(e) AS row FROM legal_entities e")).rows[0].row).toEqual({ ...before, timezone: JERUSALEM });
      await expect(legacy.query("UPDATE legal_entities SET timezone=' '")).rejects.toMatchObject({ code: "23514" });
    } finally {
      await legacy.end();
      await pool.query(`DROP SCHEMA ${namespace} CASCADE`);
    }
  });

  it("resolves all four states on one held client, using created_at then id for mixed branches", async () => {
    const { entityReportZone } = await zoneModule();
    await inTransaction(async client => {
      const resolve = () => entityReportZone(client, entity);
      expect(await resolve()).toEqual({ zone: TORONTO, source: "shared_branches", mixed: false });
      await client.query("UPDATE legal_entities SET timezone=$1 WHERE id=$2", [JERUSALEM, entity]);
      expect(await resolve()).toEqual({ zone: JERUSALEM, source: "entity", mixed: false });
      await client.query("UPDATE legal_entities SET timezone=NULL WHERE id=$1", [entity]);
      await client.query("UPDATE branches SET timezone=$1 WHERE id=$2", [JERUSALEM, branch]);
      // Reverse insertion order, equal timestamps: id must break the tie.
      for (const id of ["z", "a"]) await client.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name,timezone,created_at) VALUES ($1,$2,$3,$1,$4,'2019-01-01')", [`${id}-${entity}`, tenant, entity, id === "a" ? TORONTO : VANCOUVER]);
      expect(await resolve()).toEqual({ zone: TORONTO, source: "first_branch", mixed: true });
      await client.query("UPDATE branches SET timezone='  Asia/Jerusalem  ' WHERE legal_entity_id=$1", [entity]);
      expect(await resolve()).toEqual({ zone: JERUSALEM, source: "shared_branches", mixed: false });
      await client.query("INSERT INTO legal_entities(id,tenant_id,name) VALUES ($1,$2,'No branches')", [`empty-${entity}`, tenant]);
      expect(await entityReportZone(client, `empty-${entity}`)).toEqual({ zone: TORONTO, source: "default", mixed: false });
      expect(pool.totalCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
    });
  });

  it("ignores an invalid entity setting and handles an invalid earliest branch without skipping it", async () => {
    const { entityReportZone } = await zoneModule();
    await inTransaction(async client => {
      await client.query("UPDATE legal_entities SET timezone='Mars/Olympus' WHERE id=$1", [entity]);
      expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "shared_branches", mixed: false });
      await client.query("UPDATE branches SET timezone='Mars/Olympus' WHERE id=$1", [branch]);
      expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "default", mixed: false });
      await client.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name,timezone) VALUES ($1,$2,$3,'Later',$4)", [`later-${entity}`, tenant, entity, JERUSALEM]);
      expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "default", mixed: true });
      await client.query("UPDATE branches SET timezone=$1 WHERE id=$2", [VANCOUVER, branch]);
      await client.query("UPDATE branches SET timezone='' WHERE id=$1", [`later-${entity}`]);
      expect(await entityReportZone(client, entity)).toEqual({ zone: VANCOUVER, source: "first_branch", mixed: true });
    });
  });

  it("recovers missing tables with savepoints and propagates other database errors without aborting the caller", async () => {
    const { entityReportZone } = await zoneModule();
    await inTransaction(async client => {
      await client.query("ALTER TABLE branches RENAME TO entity_zone_held_branches");
      expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "default", mixed: false });
      await client.query("UPDATE legal_entities SET timezone=$1 WHERE id=$2", [JERUSALEM, entity]);
      expect(await entityReportZone(client, entity)).toEqual({ zone: JERUSALEM, source: "entity", mixed: false });
    });
    await inTransaction(async client => {
      await client.query("ALTER TABLE legal_entities RENAME TO entity_zone_held_entities");
      expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "shared_branches", mixed: false });
      await client.query("ALTER TABLE branches RENAME TO entity_zone_held_branches");
      for (let i = 0; i < 3; i++) expect(await entityReportZone(client, entity)).toEqual({ zone: TORONTO, source: "default", mixed: false });
      expect((await client.query("SELECT 1 AS alive")).rows[0].alive).toBe(1);
    });
    await inTransaction(async client => {
      await client.query("ALTER TABLE branches RENAME COLUMN created_at TO hidden_created_at");
      await expect(entityReportZone(client, entity)).rejects.toMatchObject({ code: "42703" });
      expect((await client.query("SELECT 1 AS alive")).rows[0].alive).toBe(1);
    });
  });

  it("lets the owner set and clear, with session-scoped before/after audits and one held service client", async () => {
    const response = await put({ zone: `  ${JERUSALEM}  ` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ zone: JERUSALEM, source: "entity", mixed: false, setting: JERUSALEM });
    expect(await stored()).toBe(JERUSALEM);
    const first = (await audits())[0];
    expect(first).toMatchObject({ tenant_id: tenant, legal_entity_id: entity, actor_id: owner.userId, target_id: entity, branch_id: branch, workspace_id: workspace });
    expect(JSON.parse(first.reason)).toEqual({ before: { zone: TORONTO, source: "shared_branches", mixed: false, setting: null }, after: response.json() });
    const { EntityZoneService } = await zoneModule();
    expect(await new EntityZoneService(pool).current(owner)).toEqual(response.json());
    const cleared = await put({ zone: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toEqual({ zone: TORONTO, source: "shared_branches", mixed: false, setting: null });
    expect(await stored()).toBeNull();
    expect((await audits())).toHaveLength(2);
    expect(JSON.parse((await audits())[1].reason)).toEqual({ before: response.json(), after: cleared.json() });
    await new EntityZoneService(pool).set(owner, JERUSALEM);
    expect(pool.totalCount).toBe(1);
  });

  it.each(roles.filter(role => role !== "administrator"))("allows %s to read but refuses changes without changing the setting or audit", async role => {
    expect((await get(role)).statusCode).toBe(200);
    const response = await put({ zone: JERUSALEM }, role);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe("AUTHORIZATION_DENIED");
    expect(await stored()).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it.each([{ zone: "Mars/Olympus" }, { zone: "+01:00" }, { zone: "" }, { zone: "   " }, { zone: "a".repeat(65) }, { zone: 42 }, {}, { zone: JERUSALEM, legalEntityId: "other" }, { zone: JERUSALEM, actorId: "other" }])("rejects malformed input %j with 400 and no writes", async payload => {
    const response = await put(payload);
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json().code).toBe("INVALID_REQUEST");
    expect(await stored()).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it("isolates other entities and tenants, rejects foreign workspaces, and requires a session", async () => {
    const otherTenant = `${tenant}-other`;
    const otherEntity = `${entity}-other`;
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Other')", [otherTenant]);
    await pool.query("INSERT INTO legal_entities(id,tenant_id,name,timezone) VALUES ($1,$2,'Other','America/Vancouver'),($3,$4,'Sibling','Asia/Jerusalem')", [otherEntity, otherTenant, `${entity}-sibling`, tenant]);
    await pool.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Other')", [`${branch}-other`, otherTenant, otherEntity]);
    await pool.query("INSERT INTO workspaces(id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$4,'other')", [`${workspace}-other`, otherTenant, otherEntity, `${branch}-other`]);
    expect((await put({ zone: JERUSALEM }, "administrator", { "x-workspace-id": `${workspace}-other` })).statusCode).toBe(403);
    expect((await get("administrator", { "x-workspace-id": `${workspace}-other` })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/ledger/entity-zone" })).statusCode).toBe(401);
    expect((await put({ zone: TORONTO })).statusCode).toBe(200);
    expect((await pool.query("SELECT timezone FROM legal_entities WHERE id IN ($1,$2) ORDER BY id", [otherEntity, `${entity}-sibling`])).rows).toEqual([{ timezone: VANCOUVER }, { timezone: JERUSALEM }]);
    const { EntityZoneService } = await zoneModule();
    // Even a mismatched internal principal cannot override the entity's tenant.
    const forged = { ...owner, legalEntityId: otherEntity };
    await ensureLedgerPrincipal(pool, forged);
    await expect(new EntityZoneService(pool).set(forged, TORONTO)).rejects.toMatchObject({ code: "LEGAL_ENTITY_NOT_FOUND" });
    await expect(new EntityZoneService(pool).current(forged)).rejects.toMatchObject({ code: "LEGAL_ENTITY_NOT_FOUND" });
    expect(await audits()).toHaveLength(1);
  });

  it("rolls back the setting when audit insertion fails", async () => {
    await pool.query(`CREATE FUNCTION zone_test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='entity_timezone.change' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zone_test_refuse_audit BEFORE INSERT ON ledger_audit_events FOR EACH ROW EXECUTE FUNCTION zone_test_refuse_audit()`);
    try {
      const response = await put({ zone: JERUSALEM });
      expect(response.statusCode, response.body).toBe(500);
      expect(await stored()).toBeNull();
      expect(await audits()).toHaveLength(0);
    } finally {
      await pool.query("DROP TRIGGER zone_test_refuse_audit ON ledger_audit_events; DROP FUNCTION zone_test_refuse_audit()");
    }
  });

  it("serializes different owners so the second audit sees the first committed setting", async () => {
    const { EntityZoneService } = await zoneModule();
    const competingPool = new pg.Pool({ connectionString: url, max: 2 });
    const secondOwner = { ...owner, userId: `${owner.userId}-second` };
    await ensureLedgerPrincipal(pool, secondOwner);
    const held = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await held.query("BEGIN");
      await held.query("UPDATE legal_entities SET timezone=$1 WHERE id=$2", [JERUSALEM, entity]);
      const connected = await competingPool.connect();
      const pid = (await connected.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      connected.release();
      pending = new EntityZoneService(competingPool).set(secondOwner, VANCOUVER);
      // The test waits for a real row lock, not for elapsed wall-clock time.
      await vi.waitFor(async () => {
        expect((await held.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0].wait_event_type).toBe("Lock");
      }, { timeout: 3000, interval: 10 });
      await held.query("COMMIT");
      await pending;
      const audit = (await held.query("SELECT reason FROM ledger_audit_events WHERE legal_entity_id=$1 AND action='entity_timezone.change'", [entity])).rows[0];
      expect(JSON.parse(audit.reason).before.setting).toBe(JERUSALEM);
      expect(JSON.parse(audit.reason).after.setting).toBe(VANCOUVER);
    } finally {
      await held.query("ROLLBACK");
      held.release();
      await pending?.catch(() => {});
      await competingPool.end();
    }
  });
});
