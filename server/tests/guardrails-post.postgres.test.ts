/* Rates v2.5 guardrails on the server: a deal under its floor does not post
   without a reason.

   The Guardrails tab sets a floor (and a floor per currency) and what
   happens below it; the new-deal screen meters each deal against it. Until
   now only the screen checked, so a deal posted straight to the API went
   through at any margin. The server now applies the same rule when a deal
   posts (quotes/service.ts, rates/guardrails.ts):
   - margin is the booked spread plus the fee, over the deal's home side;
   - below the floor with "block" (the default) the post is refused unless
     the request carries a reason, or a manager already overrode the rate
     with one;
   - "warn" posts;
   - either way a deal under the floor is in the audit log with who, why
     and how far under.
   Setup is the quote suite's: the demo desk, a till, and a board with 2%
   buy and 3% sell margins. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const body = {
  customerId: "customer-demo",
  from: "CAD",
  to: "USD",
  inputAmount: "1000.00",
  feeCad: "4.00",
  direction: "customer_buy_foreign",
};
const postBody = (idempotencyKey: string, overrides: Record<string, unknown> = {}) => ({
  idempotencyKey,
  purpose: "Personal travel",
  sourceOfFunds: "Employment income",
  ...overrides,
});
async function cookie(staffId = "m.costa") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
  };
}
async function reset() {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
  );
  const s = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [s[0]],
  );
  /* This desk is the Canadian demo. It has to name that pack. A missing
     pack is not filled in with Canada's rules. */
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE
       SET home_currency='CAD',
           jurisdiction_pack_id='pack-ca-v1',
           jurisdiction_pack_version=1`,
    [s[1], s[0]],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [s[2], s[0], s[1]],
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1||':m.costa',$1,$2,$3,$4,$5,'teller','[\"br-yorkville\"]'),($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','[\"br-yorkville\"]')",
    s,
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')",
    s.slice(0, 4),
  );
  for (const [c, v] of [
    ["CAD", 25000],
    ["USD", 12000],
    ["EUR", 7000],
    ["GBP", 3500],
  ])
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...s, c, v],
    );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':m.costa',now())`,
    s,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('snap-1','test','{\"USD\":1.4,\"EUR\":1.5,\"GBP\":1.7}',now())",
  );
  await pool.query(
    'INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at) VALUES (\'board-1\',$1,$2,$3,0.02,0.03,\'{"USD":{"mid":1.4,"show":true},"EUR":{"mid":1.5,"show":true},"GBP":{"mid":1.7,"show":true}}\',\'snap-1\',now())',
    s.slice(0, 3),
  );
}

const settings = async (value: unknown) => {
  await pool.query(
    "INSERT INTO tenant_state (tenant_id,state) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET state=EXCLUDED.state",
    [DEMO.tenantId, JSON.stringify({ cdos_settings: value })],
  );
};
const quoteAndPost = async (post: Record<string, unknown> = {}, quote: Record<string, unknown> = {}, staffId = "m.costa") => {
  const c = await cookie(staffId);
  const made = await app.inject({ method: "POST", url: "/api/quotes", cookies: c, payload: { ...body, ...quote } });
  expect(made.statusCode, made.body).toBe(201);
  return app.inject({ method: "POST", url: `/api/quotes/${made.json().quoteId}/post`, cookies: c, payload: postBody(`g-${Date.now()}-${Math.random()}`, post) });
};
const belowFloorAudits = async () => (await pool.query("SELECT detail FROM audit_events WHERE tenant_id=$1 AND action='deal.margin_below_floor' ORDER BY at", [DEMO.tenantId])).rows.map((r) => r.detail);

postgres("guardrails when a deal posts", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    await pool.query("DELETE FROM audit_events WHERE tenant_id=$1 AND action='deal.margin_below_floor'", [DEMO.tenantId]);
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });
  beforeEach(async () => {
    await reset();
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    await pool.query("DELETE FROM audit_events WHERE tenant_id=$1 AND action='deal.margin_below_floor'", [DEMO.tenantId]);
  });

  it("posts a deal above the floor as before, with no settings and nothing logged", async () => {
    const res = await quoteAndPost();
    expect(res.statusCode, res.body).toBe(201);
    expect(await belowFloorAudits()).toEqual([]);
  });

  it("refuses a deal under the floor without a reason, and says so in words", async () => {
    await settings({ marginFloorPct: 5 });
    const res = await quoteAndPost();
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("MARGIN_BELOW_FLOOR");
    expect(res.json().message).toMatch(/under the 5\.0% floor for USD/);
    expect(await belowFloorAudits()).toEqual([]);
  });

  it("posts it with a reason, and logs who, why and how far under", async () => {
    await settings({ marginFloorPct: 5 });
    const res = await quoteAndPost({ marginOverrideReason: "Regular client, matched the bank next door" });
    expect(res.statusCode, res.body).toBe(201);
    const [logged] = await belowFloorAudits();
    expect(logged).toMatchObject({ currency: "USD", floor: 5, enforce: "block", reason: "Regular client, matched the bank next door", given: "at_post" });
    /* As measured, a decimal string, never a float (standard §3). */
    expect(logged.marginPct).toMatch(/^\d+(\.\d+)?$/);
    expect(Number(logged.marginPct)).toBeLessThan(5);
  });

  it("counts a manager's rate override and its reason", async () => {
    await settings({ marginFloorPct: 5 });
    /* The teller quotes and posts on their till; a manager overrides the rate. */
    const teller = await cookie("m.costa"), manager = await cookie("r.haddad");
    const made = await app.inject({ method: "POST", url: "/api/quotes", cookies: teller, payload: body });
    const quoted = made.json();
    const over = await app.inject({ method: "POST", url: `/api/quotes/${quoted.quoteId}/override`, cookies: manager, payload: { customerRate: (Number(quoted.customerRate) * 1.001).toFixed(8), reason: "Corporate rate agreed by the owner" } });
    expect(over.statusCode, over.body).toBe(200);
    const res = await app.inject({ method: "POST", url: `/api/quotes/${quoted.quoteId}/post`, cookies: teller, payload: postBody("g-override") });
    expect(res.statusCode, res.body).toBe(201);
    expect((await belowFloorAudits())[0]).toMatchObject({ reason: "Corporate rate agreed by the owner", given: "rate_override" });
  });

  it("posts with warn only, and logs it", async () => {
    await settings({ marginFloorPct: 5, marginEnforce: "warn" });
    const res = await quoteAndPost();
    expect(res.statusCode, res.body).toBe(201);
    expect((await belowFloorAudits())[0]).toMatchObject({ enforce: "warn", reason: null });
  });

  it("holds a currency to its own floor, and only that currency", async () => {
    await settings({ marginFloorPct: 0.5, marginFloorByCcy: { USD: 5 } });
    expect((await quoteAndPost()).statusCode).toBe(422);
    const eur = await quoteAndPost({}, { to: "EUR" });
    expect(eur.statusCode, eur.body).toBe(201);
  });

  it("reads the settings the browser saves, as JSON text", async () => {
    await settings(JSON.stringify({ marginFloorPct: 5 }));
    expect((await quoteAndPost()).json().code).toBe("MARGIN_BELOW_FLOOR");
  });

  it("refuses a blank reason, at the route", async () => {
    await settings({ marginFloorPct: 5 });
    expect((await quoteAndPost({ marginOverrideReason: "   " })).statusCode).toBe(400);
  });
});
