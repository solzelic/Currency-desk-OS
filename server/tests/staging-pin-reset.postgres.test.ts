/* #609 PR B: on a staging database, staging runtime and test shop, every
   person's stored PIN becomes 0000. All three gates, read fresh every run,
   and a never-reset list. Its own database, so no other test sees it. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { provisionPostgres, schema } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { createSession } from "../src/auth/sessions.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { provisionDesk } from "../src/onboarding/provision.js";
import { fintracNumberFileable, runStagingPinReset, SEED_PLACEHOLDER_FINTRAC } from "../src/staging/pin-reset.js";
import { markStagingDatabase } from "../src/staging/cli.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const STAGING = { STAGING: "1", RENDER_EXTERNAL_HOSTNAME: "currencydesk-staging.onrender.com" };
const LIVE = { NODE_ENV: "production", RENDER_EXTERNAL_HOSTNAME: "currencydesk.onrender.com" };
const quiet = { warn: vi.fn(), error: vi.fn() };

it("the seed placeholder can never be filed", () => {
  expect(SEED_PLACEHOLDER_FINTRAC).toBe("M12345678");
  expect(fintracNumberFileable("M12345678")).toBe(false);
  expect(fintracNumberFileable("M87654321")).toBe(true);
});

postgres("the staging PIN reset", () => {
  const name = `staging_pin_${Date.now()}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let app: FastifyInstance;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  const rows = (sql: string, args: unknown[] = []) => pool.query(sql, args).then((r) => r.rows);
  const yorkfx = () => rows("SELECT is_test_shop, seeded_by FROM tenants WHERE id='tnt-yorkfx'").then((r) => r[0]);
  const hashes = (tenant: string) => rows("SELECT staff_id, pin_hash, pin_must_change FROM staff_users WHERE tenant_id=$1 ORDER BY staff_id", [tenant]);
  const all0000 = async (tenant: string) => {
    const list = await hashes(tenant);
    return list.length > 0 && (await Promise.all(list.map((r) => r.pin_hash ? verifyPassword("0000", r.pin_hash) : false))).every(Boolean);
  };
  const unmark = async () => {
    await pool.query("ALTER TABLE db_environment DISABLE TRIGGER USER");
    await pool.query("DELETE FROM db_environment");
    await pool.query("ALTER TABLE db_environment ENABLE TRIGGER USER");
  };
  const shop = async (slug: string, isTestShop: boolean, msb: string | null = null) => {
    const made = await provisionDesk(db as never, {
      businessName: slug, legalName: slug, ownerName: "Owner", email: `${slug}@example.test`, slug, plan: "pro",
      setup: {}, msbNumber: msb, regulator: "FINTRAC", team: [], isTestShop,
    }, await hashPassword("yorkville"), "test");
    return made;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE ${name}`);
    const dbUrl = new URL(url!); dbUrl.pathname = `/${name}`;
    pool = await provisionPostgres(dbUrl.toString());
    db = drizzle(pool, { schema });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await seed(db as never);
    app = await buildApp(db as never);
  });
  afterAll(async () => {
    await app.close(); await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await unmark();
    await pool.query("UPDATE tenants SET is_test_shop=false, seeded_by=NULL WHERE id='tnt-yorkfx'");
    await pool.query("UPDATE legal_entities SET msb_number=$1 WHERE tenant_id='tnt-yorkfx'", [SEED_PLACEHOLDER_FINTRAC]);
    await pool.query("UPDATE staff_users SET pin_hash=NULL, pin_must_change=true WHERE tenant_id='tnt-yorkfx'");
  });

  it("the CLI marks staging only on a staging runtime, once, with an audit row; no route or live insert", async () => {
    expect(await markStagingDatabase(pool, LIVE, quiet)).toBe("refused");
    expect(await rows("SELECT * FROM db_environment")).toHaveLength(0);
    expect(await markStagingDatabase(pool, STAGING, quiet)).toBe("inserted");
    expect(await markStagingDatabase(pool, STAGING, quiet)).toBe("already");
    expect((await rows("SELECT environment FROM db_environment")).map((r) => r.environment)).toEqual(["staging"]);
    expect(await rows("SELECT 1 FROM audit_events WHERE action='db.environment_marked'")).toHaveLength(1);
  });

  it("the table refuses UPDATE, DELETE and TRUNCATE", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    for (const sql of ["UPDATE db_environment SET environment='live'", "DELETE FROM db_environment", "TRUNCATE db_environment"]) {
      await expect(pool.query(sql), sql).rejects.toThrow(/insert only/);
    }
    await expect(pool.query("INSERT INTO db_environment (environment) VALUES ('production')")).rejects.toThrow();
  });

  it("refuses unless all three gates pass: an unmarked database, a live runtime, or a real shop", async () => {
    await runStagingPinReset(pool, STAGING, quiet);
    expect(await yorkfx()).toEqual({ is_test_shop: false, seeded_by: null });
    await markStagingDatabase(pool, STAGING, quiet);
    await runStagingPinReset(pool, LIVE, quiet);
    expect(await yorkfx()).toEqual({ is_test_shop: false, seeded_by: null });
    const real = await shop("realshop", false);
    await runStagingPinReset(pool, STAGING, quiet);
    expect((await hashes(real.tenantId)).every((r) => r.pin_hash === null)).toBe(true);
    expect(await rows("SELECT is_test_shop FROM tenants WHERE id=$1", [real.tenantId])).toEqual([{ is_test_shop: false }]);
    expect(await rows("SELECT 1 FROM audit_events WHERE action='pin.staging_reset' AND tenant_id=$1", [real.tenantId])).toHaveLength(0);
  });

  it("on a marked staging database York FX becomes a test shop and everyone's PIN is 0000", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    await runStagingPinReset(pool, STAGING, quiet);
    expect(await yorkfx()).toEqual({ is_test_shop: true, seeded_by: "staging_seed" });
    expect(await all0000("tnt-yorkfx")).toBe(true);
    expect((await hashes("tnt-yorkfx")).every((r) => r.pin_must_change === false)).toBe(true);
    const audits = await rows("SELECT actor_id, detail FROM audit_events WHERE action='pin.staging_reset' AND tenant_id='tnt-yorkfx'");
    expect(audits).toHaveLength((await hashes("tnt-yorkfx")).length);
    expect(audits[0]).toMatchObject({ actor_id: "system", detail: { reason: "staging_reset" } });
    expect(JSON.stringify(audits)).not.toMatch(/0000|pin_hash|scrypt|\$argon/);
    expect(await rows("SELECT detail FROM audit_events WHERE action='tenant.test_shop_changed'")).toEqual([
      { detail: { reason: "staging_demo_seed", old: false, new: true } },
    ]);
    const as = async (staffId: string) => ({ cdos_session: (await createSession(db as never, `tnt-yorkfx:${staffId}`, { workspaceId: null })).token });
    const verify = await app.inject({ method: "POST", url: "/api/staff/pin/verify", cookies: await as("a.singh"), payload: { pin: "0000" } });
    expect(verify.statusCode, verify.body).toBe(200);
    const sw = await app.inject({ method: "POST", url: "/api/auth/switch", cookies: await as("a.singh"), payload: { staffId: "m.costa", pin: "0000" } });
    expect(sw.statusCode, sw.body).toBe(200);
  });

  it("a second run changes nothing", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    await runStagingPinReset(pool, STAGING, quiet);
    const first = await hashes("tnt-yorkfx");
    const audits = (await rows("SELECT 1 FROM audit_events WHERE action='pin.staging_reset'")).length;
    await runStagingPinReset(pool, STAGING, quiet);
    expect(await hashes("tnt-yorkfx")).toEqual(first);
    expect(await rows("SELECT 1 FROM audit_events WHERE action='pin.staging_reset'")).toHaveLength(audits);
  });

  it("the seed shop is not marked with a real or near-placeholder FINTRAC number", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    for (const msb of ["M87654321", " M12345678", "m12345678"]) {
      await pool.query("UPDATE legal_entities SET msb_number=$1 WHERE tenant_id='tnt-yorkfx'", [msb]);
      await runStagingPinReset(pool, STAGING, quiet);
      expect((await yorkfx()).is_test_shop, msb).toBe(false);
    }
  });

  it("never resets a test shop with a live key, a Persona inquiry, a live Stripe object or a real filing", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    const blockers: Record<string, (t: { tenantId: string; legalEntityId: string; branchId: string }) => Promise<unknown>> = {
      key: (t) => pool.query("INSERT INTO idv_shop_config (shop_id, api_key_ref) VALUES ($1, 'PERSONA_API_KEY_LIVE')", [t.legalEntityId]),
      inquiry: (t) => pool.query("INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref) VALUES ($1,$2,$3,'x','persona',$1)", [randomUUID(), t.legalEntityId, t.branchId]),
      stripe: (t) => pool.query("INSERT INTO stripe_events (stripe_event_id, type, tenant_id, livemode) VALUES ($1,'customer.created',$2,true)", [randomUUID(), t.tenantId]),
      filing: (t) => pool.query(
        `INSERT INTO ledger_report_filings (filing_id, tenant_id, legal_entity_id, branch_id, report_id, pack_id, pack_version, report_code, status, payload, acknowledgement_ref, created_by)
         SELECT $1,$2,$3,$4, r.report_id, r.pack_id, p.version, r.code, 'filed', '{}'::jsonb, 'ACK-1', 'x'
           FROM jurisdiction_reports r JOIN jurisdiction_packs p USING (pack_id) LIMIT 1`,
        [randomUUID(), t.tenantId, t.legalEntityId, t.branchId]),
      fintrac: (t) => pool.query("UPDATE legal_entities SET msb_number='M87654321' WHERE id=$1", [t.legalEntityId]),
    };
    for (const [why, block] of Object.entries(blockers)) {
      const made = await shop(`test${why}`, true);
      await block(made);
      await runStagingPinReset(pool, STAGING, quiet);
      expect((await hashes(made.tenantId)).every((r) => r.pin_hash === null), why).toBe(true);
    }
    const clean = await shop("testclean", true);
    await runStagingPinReset(pool, STAGING, quiet);
    expect(await all0000(clean.tenantId)).toBe(true);
  });

  it("a person who is also in a real shop is not reset", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    const test = await shop("testboth", true);
    const real = await shop("realboth", false);
    const owner = (await hashes(test.tenantId))[0]!.staff_id;
    await pool.query("UPDATE staff_users SET staff_id=$1 WHERE tenant_id=$2", [owner.toUpperCase(), real.tenantId]);
    await runStagingPinReset(pool, STAGING, quiet);
    expect((await hashes(test.tenantId))[0]!.pin_hash).toBeNull();
  });

  it("a lookup that throws changes nothing, logs one line and does not throw", async () => {
    await markStagingDatabase(pool, STAGING, quiet);
    const log = { warn: vi.fn(), error: vi.fn() };
    const broken = { connect: async () => { const c = await pool.connect(); const q = c.query.bind(c); return Object.assign(c, { query: (sql: unknown, ...a: unknown[]) => String(sql).includes("staff_users") ? Promise.reject(new Error("boom")) : (q as (...x: unknown[]) => unknown)(sql, ...a) }); }, query: pool.query.bind(pool) };
    await expect(runStagingPinReset(broken as never, STAGING, log)).resolves.toBeDefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0])).not.toMatch(/0000|hash/i);
    expect(await yorkfx()).toEqual({ is_test_shop: false, seeded_by: null });
    expect((await hashes("tnt-yorkfx")).every((r) => r.pin_hash === null)).toBe(true);
  });
});
