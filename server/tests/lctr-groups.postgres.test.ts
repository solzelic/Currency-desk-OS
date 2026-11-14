/* CD107 A1: synthetic receipts, real auth/routes and PostgreSQL. No filing
   acceptance is claimed by this read-only slice. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { createSession } from "../src/auth/sessions.js";
import { buildApp } from "../src/app.js";
import { ensureLedgerPrincipal } from "../src/ledger/principal.js";
import type { LedgerActor } from "../src/ledger/service.js";
import { cashReceived, BOOKING_ERROR_REASON } from "../src/ledger/canada-rules.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const DAY = "2026-06-15", ZONE = "America/Toronto";
const rules = () => import("../src/ledger/canada-rules.js");
const serviceModule = () => import("../src/ledger/lctr-groups.js");
const roles = ["administrator", "branch_manager", "supervisor", "compliance_officer", "teller", "auditor"] as const;

postgres("entity shop-day LCTR groups", () => {
  let pool: pg.Pool, handle: DbHandle, app: FastifyInstance;
  let tenant: string, entity: string, branch: string, otherBranch: string, workspace: string;
  let owner: LedgerActor;
  let cookies: Record<string, { cdos_session: string }>;
  beforeAll(async () => {
    // postgres() only executes with TEST_DATABASE_URL present.
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
    tenant = `lctr-t-${suffix}`; entity = `lctr-e-${suffix}`;
    branch = `lctr-b1-${suffix}`; otherBranch = `lctr-b2-${suffix}`;
    workspace = `lctr-w-${suffix}`;
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Synthetic LCTR shop')", [tenant]);
    await pool.query("INSERT INTO legal_entities(id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version) VALUES ($1,$2,'Synthetic entity','CAD','pack-ca-v2',2)", [entity, tenant]);
    for (const [id, date] of [[branch, "2020-01-01"], [otherBranch, "2020-01-02"]]) {
      await pool.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name,timezone,created_at) VALUES ($1,$2,$3,'Synthetic branch',$4,$5)", [id, tenant, entity, ZONE, date]);
    }
    await pool.query("INSERT INTO workspaces(id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$4,'lctr-till')", [workspace, tenant, entity, branch]);
    cookies = {};
    for (const role of roles) {
      const userId = `${suffix}-${role}`;
      await pool.query(`INSERT INTO staff_users(id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash)
        VALUES ($1,$2,$3,$4,$1,'Synthetic staff',$5,$6,'not-a-login-hash')`, [userId, tenant, entity, branch, role, JSON.stringify([branch])]);
      cookies[role] = { cdos_session: (await createSession(handle.db, userId)).token };
      if (role === "administrator") owner = { userId, tenantId: tenant, legalEntityId: entity, branchId: branch, workspaceId: workspace, tillId: "lctr-till", role, authorizedBranchIds: [branch] };
    }
    await ensureLedgerPrincipal(pool, owner);
  });

  function get(query = `day=${DAY}`, role = "administrator", headers = {}) {
    return app.inject({ method: "GET", url: `/api/ledger/lctr-groups?${query}`, cookies: cookies[role], headers });
  }
  async function receipt(amount: string, options: {
    customer?: string; branchId?: string; at?: string; kind?: string;
    cash?: string | null; from?: string; thirdParty?: string; beneficiary?: string;
    reason?: string; entityId?: string; tenantId?: string;
  } = {}, executor = pool) {
    const id = randomUUID(), customer = options.customer ?? "customer-a";
    const cash = options.cash === undefined ? amount : options.cash;
    await executor.query(`INSERT INTO ledger_transactions
      (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,
       from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at,
       deal_kind,received_instrument,disbursed_instrument,cash_in_home,home_currency,third_party,third_party_name)
      VALUES ($1,$1,$2,$3,$4,$5,'lctr-till',$6,$7,$8,'USD',$9,$9,1,0,0,'Synthetic','Synthetic',$10,$11,'cash','cash',$12,'CAD',$13,$14)`,
    [id, options.tenantId ?? tenant, options.entityId ?? entity, options.branchId ?? branch, workspace, customer, owner.userId,
      options.from ?? "CAD", amount, options.at ?? `${DAY}T16:00:00Z`, options.kind ?? "exchange", cash, Boolean(options.thirdParty?.trim()), options.thirdParty?.trim() ? options.thirdParty : null]);
    if (options.beneficiary !== undefined) {
      await pool.query(`INSERT INTO ledger_obligations
        (obligation_id,obligation_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,transaction_id,kind,direction,
         counterparty,face_currency,face_amount,home_currency,carrying_amount_home,status,opened_at,created_by,beneficiary_name)
        VALUES ($1,$1,$2,$3,$4,$5,'lctr-till',$6,$1,'remittance_payable','payable','Synthetic','CAD',$7,'CAD',$7,'open',$8,$9,$10)`,
      [id, tenant, entity, options.branchId ?? branch, workspace, customer, amount, `${DAY}T16:00:00Z`, owner.userId, options.beneficiary]);
    }
    if (options.reason !== undefined) await pool.query("INSERT INTO ledger_reversals(reversal_id,transaction_id,actor_id,reason,posted_at) VALUES ($1,$1,$2,$3,'2026-06-17T12:00:00Z')", [id, owner.userId, options.reason]);
    return id;
  }
  async function read() {
    const { LctrGroupsService } = await serviceModule();
    return new LctrGroupsService(pool).forDay(owner, DAY);
  }

  it("two branches at 6000 make one 12000 conductor group even with access to only one branch", async () => {
    const first = await receipt("6000.00"), second = await receipt("6000.00", { branchId: otherBranch });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ day: DAY, zone: ZONE, zoneSource: "shared_branches", mixed: false, trigger: "10000.00", groups: [
      { axis: "conductor", key: "customer-a", total: "12000.00", transactionIds: [first, second].sort(), branchIds: [branch, otherBranch].sort(), needsReport: true },
    ] });
  });

  it("counts all 120 receipts without the browser cap, with deterministic unique arrays", async () => {
    const ids = [];
    for (let i = 0; i < 120; i++) ids.push(await receipt("100.01", { branchId: i % 2 ? branch : otherBranch }));
    const result = await read();
    expect(result.groups).toEqual([{ axis: "conductor", key: "customer-a", total: "12001.20", transactionIds: ids.sort(), branchIds: [branch, otherBranch].sort(), needsReport: true }]);
    expect(await read()).toEqual(result);
  });

  it("matches cashReceived on all axes and retains its exact reversal, amount and non-deal rules", async () => {
    const included = [];
    for (const reason of [undefined, "Customer changed their mind", ""]) {
      included.push(await receipt("123.45", { thirdParty: "  Alice  ", beneficiary: " BOB ", reason }));
    }
    included.push(await receipt("20.10", { cash: null, thirdParty: "ALICE", beneficiary: "bob" }));
    included.push(await receipt("100.00", { cash: "7.25", from: "EUR", thirdParty: "alice", beneficiary: "bob" }));
    included.push(await receipt("1.01", { kind: "remittance_send", thirdParty: "alice", beneficiary: "bob" }));
    await receipt("999.00", { reason: BOOKING_ERROR_REASON, thirdParty: "alice", beneficiary: "bob" });
    for (const kind of ["cheque_clearing", "cheque_return"]) await receipt("999.00", { kind, thirdParty: "alice", beneficiary: "bob" });
    await receipt("999.00", { kind: "cheque_cashing", cash: null, thirdParty: "alice", beneficiary: "bob" });
    await receipt("999.00", { cash: null, from: "EUR", thirdParty: "alice", beneficiary: "bob" });
    await receipt("999.00", { cash: "0.00", thirdParty: "alice", beneficiary: "bob" });
    const result = await read();
    expect(result.groups).toHaveLength(3);
    const client = await pool.connect();
    try {
      for (const group of result.groups) {
        expect(group.total).toBe("398.71");
        expect(group.needsReport).toBe(false);
        expect(group.transactionIds).toEqual(included.sort());
        expect(group.total).toBe((await cashReceived(client, entity, { start: new Date(result.window.start), end: new Date(result.window.end) }, group.axis, group.key)).toFixed(2));
      }
      const groups = await (await rules()).cashReceivedGroups(client, entity, { start: new Date(result.window.start), end: new Date(result.window.end) }, ["beneficiary"]);
      expect(groups.map(g => [g.axis, g.key, g.total.toFixed(2)])).toEqual([["beneficiary", "bob", "398.71"]]);
    } finally { client.release(); }
  });

  it("does not add axes or invent groups for empty names", async () => {
    await receipt("6000.00", { customer: "same", thirdParty: " SAME ", beneficiary: "same" });
    const result = await read();
    expect(result.groups.map(g => [g.axis, g.key, g.total, g.needsReport])).toEqual([
      ["beneficiary", "same", "6000.00", false], ["conductor", "same", "6000.00", false], ["on_behalf_of", "same", "6000.00", false],
    ]);
    await receipt("100.00", { customer: "empty-names", thirdParty: "   ", beneficiary: "   " });
    expect((await read()).groups.filter(g => g.key === "")).toEqual([]);
  });

  it("uses [local midnight,next midnight), including the last second and excluding next 00:00", async () => {
    await receipt("100.00", { at: "2026-06-15T03:59:59.999Z" });
    const start = await receipt("1.00", { at: "2026-06-15T04:00:00Z" });
    const last = await receipt("2.00", { at: "2026-06-16T03:59:59Z" });
    await receipt("100.00", { at: "2026-06-16T04:00:00Z" });
    const result = await read();
    expect(result.window).toEqual({ start: "2026-06-15T04:00:00.000Z", end: "2026-06-16T04:00:00.000Z", startOffset: "-04:00", endOffset: "-04:00" });
    expect(result.groups[0]).toMatchObject({ total: "3.00", transactionIds: [start, last].sort() });
  });

  it.each([
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", "-05:00", "-04:00", 23],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", "-04:00", "-05:00", 25],
  ])("Toronto DST day %s has independent calendar boundaries", async (day, start, end, startOffset, endOffset, hours) => {
    const id = await receipt("1.00", { at: new Date(Date.parse(end) - 1).toISOString() });
    await receipt("99.00", { at: end });
    const response = await get(`day=${day}`);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.window).toEqual({ start, end, startOffset, endOffset });
    expect((Date.parse(end) - Date.parse(start)) / 3600000).toBe(hours);
    expect(result.groups[0]).toMatchObject({ total: "1.00", transactionIds: [id] });
  });

  it.each(["", "day=", "day=2026-02-29", "day=2026-02-30", "day=1900-02-29", "day=2026-13-01", "day=2026-04-31", "day=2026-01-00", "day=2026-6-15", "day=2026-06-15T00:00:00Z", "day=%202026-06-15", "day=0000-01-01", "day=10000-01-01", "day=2026-06-15&day=2026-06-16"]) (
    "rejects invalid required civil day: %s", async query => {
      const response = await get(query);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    },
  );

  it.each(["0001-01-01", "0099-12-31", "0100-01-01", "2000-02-29", "2024-02-29", "9999-12-31"])("supports real Gregorian civil day %s without year remapping", async day => {
    await pool.query("UPDATE legal_entities SET timezone='UTC' WHERE id=$1", [entity]);
    const response = await get(`day=${day}`);
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.window.start).toBe(`${day}T00:00:00.000Z`);
    expect(Date.parse(result.window.end) - Date.parse(result.window.start)).toBe(86400000);
    expect(result.window.startOffset).toBe("+00:00");
  });

  it("keeps large numeric totals exact, beyond floating-point and default Decimal precision", async () => {
    await receipt("9999999999999999999999.99");
    await receipt("0.02");
    expect((await read()).groups[0]?.total).toBe("10000000000000000000000.01");
  });

  it.each([[null, "10000.00"], ["20000.00", "10000.00"], ["5000.00", "5000.00"]])("keeps existing pack/desk trigger precedence for %s", async (desk, trigger) => {
    await pool.query("UPDATE legal_entities SET report_threshold=$1 WHERE id=$2", [desk, entity]);
    await receipt("6000.00");
    const result = await read();
    expect(result.trigger).toBe(trigger);
    expect(result.groups[0]?.needsReport).toBe(desk === "5000.00");
  });

  it("returns unknown trigger and needsReport without a large-cash rule, even with a desk number", async () => {
    await pool.query("UPDATE legal_entities SET jurisdiction_pack_id='pack-gb-v2',report_threshold=5000 WHERE id=$1", [entity]);
    await receipt("12000.00");
    expect(await read()).toMatchObject({ trigger: null, groups: [{ total: "12000.00", needsReport: null }] });
  });

  it.each(roles)("uses the actual filing:view permission map for %s", async role => {
    const response = await get(undefined, role);
    expect(response.statusCode).toBe(role === "teller" || role === "auditor" ? 403 : 200);
    if (response.statusCode === 403) expect(response.json()).toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  describe.each(["teller", "auditor", "signed-out"])("query authorization for %s", role => {
    it.each(["", "day=invalid", "day=2026-02-30", "day=2026-06-15&extra=1"])("precedes query validation: %s", async query => {
      const response = role === "signed-out"
        ? await app.inject({ method: "GET", url: `/api/ledger/lctr-groups?${query}` })
        : await get(query, role);
      expect(response.statusCode).toBe(role === "signed-out" ? 401 : 403);
      expect(response.json()).toMatchObject({ code: role === "signed-out" ? "AUTHENTICATION_REQUIRED" : "AUTHORIZATION_DENIED" });
    });
  });

  it("does not trust an actor's claimed role", async () => {
    await pool.query("UPDATE ledger_principals SET role='teller' WHERE user_id=$1", [owner.userId]);
    await expect(read()).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(pool.idleCount).toBe(1);
  });

  it("isolates other entities in the same tenant and other tenants, refusing scope query fields", async () => {
    const own = await receipt("1.00");
    const alienTenant = `alien-${tenant}`, alienEntity = `alien-${entity}`, sibling = `sibling-${entity}`;
    await pool.query("INSERT INTO tenants(id,name) VALUES ($1,'Synthetic other shop')", [alienTenant]);
    for (const [id, tid] of [[alienEntity, alienTenant], [sibling, tenant]]) {
      await pool.query("INSERT INTO legal_entities(id,tenant_id,name) VALUES ($1,$2,'Other entity')", [id, tid]);
      await receipt("99999.00", { entityId: id, tenantId: tid });
    }
    expect((await read()).groups[0]).toMatchObject({ total: "1.00", transactionIds: [own] });
    for (const field of ["entityId", "legalEntityId", "tenantId", "branchId", "limit", "axes"]) {
      const response = await get(`day=${DAY}&${field}=spoof`);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "INVALID_REQUEST" });
    }
    await pool.query("INSERT INTO branches(id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Foreign')", [alienEntity, alienTenant, alienEntity]);
    await pool.query("INSERT INTO workspaces(id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$3,'alien')", [alienEntity, alienTenant, alienEntity]);
    expect((await get(undefined, "administrator", { "x-workspace-id": alienEntity })).statusCode).toBe(403);
    const { LctrGroupsService } = await serviceModule();
    const forged = { ...owner, tenantId: alienTenant };
    await ensureLedgerPrincipal(pool, forged);
    await expect(new LctrGroupsService(pool).forDay(forged, DAY)).rejects.toMatchObject({ code: "LEGAL_ENTITY_NOT_FOUND" });
  });

  it("uses one snapshot when the zone, threshold and receipts change during the read", async () => {
    await receipt("6000.00");
    const zones = await import("../src/ledger/entity-zone.js");
    const original = zones.entityReportZone;
    const writer = new pg.Pool({ connectionString: url, max: 1 });
    const spy = vi.spyOn(zones, "entityReportZone").mockImplementationOnce(async (client, id) => {
      const resolved = await original(client, id);
      await writer.query("UPDATE legal_entities SET timezone='America/Vancouver',report_threshold=5000 WHERE id=$1", [entity]);
      await receipt("1000.00", {}, writer);
      return resolved;
    });
    try {
      expect(await read()).toMatchObject({ zone: ZONE, trigger: "10000.00", groups: [{ total: "6000.00", needsReport: false }] });
      expect(await read()).toMatchObject({ zone: "America/Vancouver", trigger: "5000.00", groups: [{ total: "7000.00", needsReport: true }] });
    } finally {
      spy.mockRestore();
      await writer.end();
    }
  });

  it("propagates a database error, rolls back and releases the single client", async () => {
    const module = await rules();
    const spy = vi.spyOn(module, "cashReceivedGroups").mockImplementationOnce(async client => {
      await client.query("SELECT cd107_missing_column FROM legal_entities");
      throw new Error("The invalid query should fail first");
    });
    try {
      await expect(read()).rejects.toMatchObject({ code: "42703" });
      expect(pool.idleCount).toBe(1);
      expect((await pool.query("SELECT txid_current_if_assigned() AS tx")).rows[0].tx).toBeNull();
    } finally { spy.mockRestore(); }
    expect((await read()).groups).toEqual([]);
  });

  it("handles a midnight gap, overlap and skipped day without changing the rolling helpers", async () => {
    const { shopDayWindow } = await rules();
    expect(shopDayWindow("2018-11-04", "America/Sao_Paulo").start.toISOString()).toBe("2018-11-04T03:00:00.000Z");
    expect(shopDayWindow("2026-11-01", "America/Havana").start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(shopDayWindow("2011-12-29", "Pacific/Apia").end.toISOString()).toBe("2011-12-30T10:00:00.000Z");
    expect(() => shopDayWindow("2011-12-30", "Pacific/Apia")).toThrow();
  });

  it("passes through resolver zoneSource and mixed on its single held client", async () => {
    expect(await read()).toMatchObject({ zone: ZONE, zoneSource: "shared_branches", mixed: false });
    await pool.query("UPDATE branches SET timezone='America/Vancouver' WHERE id=$1", [otherBranch]);
    expect(await read()).toMatchObject({ zone: ZONE, zoneSource: "first_branch", mixed: true });
    await pool.query("UPDATE branches SET timezone='bad/zone' WHERE id=$1", [branch]);
    expect(await read()).toMatchObject({ zone: ZONE, zoneSource: "default", mixed: true });
    await pool.query("UPDATE legal_entities SET timezone='Asia/Kathmandu' WHERE id=$1", [entity]);
    expect(await read()).toMatchObject({ zone: "Asia/Kathmandu", zoneSource: "entity", mixed: false, window: { start: "2026-06-14T18:15:00.000Z", startOffset: "+05:45", endOffset: "+05:45" } });
    expect(pool.totalCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(1);
  });
});
