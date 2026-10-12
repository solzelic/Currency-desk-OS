/* The close of day, on a real Postgres ledger.

   The phone used to add the drawer up and keep the signature in
   localStorage. These cases ask the endpoint. A teller is refused.
   One session signs once. 10,000.00 counts and 9,999.99 does not.
   6,000 and 4,500 for one customer on the same day is an LCTR even
   though neither deal is over the line alone. */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;

const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

async function cookie(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  expect(login.statusCode).toBe(200);
  return {
    cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value,
  };
}

async function reset() {
  await pool.query(
    `TRUNCATE ledger_till_signoffs,ledger_vault_balances,ledger_vault_movements,
      ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,
      quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,
      ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,
      ledger_reversal_entries,ledger_reversals,ledger_till_movements,
      ledger_journal_entries,ledger_transactions,ledger_idempotency,
      ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,
      rate_boards,market_rates CASCADE`,
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET name='York FX Canada', jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name,timezone) VALUES ($1,$2,$3,'Yorkville','America/Toronto') ON CONFLICT (id) DO UPDATE SET timezone='America/Toronto'",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES
      ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]'),
      ($1||':m.costa',$1,$2,$3,$4,$5,'teller','["br-yorkville"]')`,
    scope,
  );
  await handle.db
    .update(schema.staffUsers)
    .set({ role: "branch_manager", authorizedBranchIds: [DEMO.branchId] })
    .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:r.haddad`));
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')",
    scope.slice(0, 4),
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('signoff-session',$1,$2,$3,$4,$5,1,'2026-10-12','open',$1||':r.haddad','2026-10-12T16:00:00.000Z')`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('signoff-snap','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('signoff-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','signoff-snap',now())`,
    scope.slice(0, 3),
  );
  await pool.query(
    "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'USD',1.4) ON CONFLICT DO NOTHING",
    scope.slice(0, 4),
  );
}

async function hold(currency: string, amount: string, avgCost: string | null) {
  await pool.query(
    `INSERT INTO ledger_till_balances
      (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount,avg_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [...scope, currency, amount, avgCost],
  );
}

async function postDeal(inputAmount: string, idempotencyKey: string, customerId = "customer-demo") {
  const cookies = await cookie("r.haddad");
  const quote = await app.inject({
    method: "POST",
    url: "/api/quotes",
    cookies,
    payload: {
      customerId,
      from: "CAD",
      to: "USD",
      inputAmount,
      feeCad: "4.00",
      direction: "customer_buy_foreign",
    },
  });
  expect(quote.statusCode, quote.body).toBe(201);
  const posted = await app.inject({
    method: "POST",
    url: `/api/quotes/${quote.json().quoteId}/post`,
    cookies,
    payload: {
      idempotencyKey,
      purpose: "Personal travel",
      sourceOfFunds: "Employment income",
    },
  });
  expect(posted.statusCode, posted.body).toBe(201);
}

async function read(staffId = "r.haddad") {
  const response = await app.inject({
    method: "GET",
    url: "/api/ledger/close-of-day",
    cookies: await cookie(staffId),
  });
  return response;
}

postgres("close of day is one signed snapshot per till session", () => {
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

  beforeEach(reset);

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  it("refuses a teller the preview and the signature", async () => {
    const preview = await read("m.costa");
    expect(preview.statusCode).toBe(403);
    const saved = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("m.costa"),
      payload: { idempotencyKey: "teller-sign", notCounted: true },
    });
    expect(saved.statusCode).toBe(403);
    const rows = await pool.query("SELECT count(*)::int AS n FROM ledger_till_signoffs");
    expect(rows.rows[0].n).toBe(0);
  });

  it("refuses a signature when the till was never opened", async () => {
    await pool.query("DELETE FROM ledger_till_sessions");
    const saved = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "no-session", notCounted: true },
    });
    expect(saved.statusCode).toBe(409);
    expect(saved.json().code).toBe("TILL_NOT_OPEN");
  });

  it("signs once, replays the same key, and refuses a second key", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "sign-1", notCounted: true },
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "sign-1", notCounted: true },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().signoffId).toBe(first.json().signoffId);
    expect(again.json().replayed).toBe(true);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "sign-1", notCounted: false },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_CONFLICT");
    const second = await app.inject({
      method: "POST",
      url: "/api/ledger/close-of-day",
      cookies: await cookie("r.haddad"),
      payload: { idempotencyKey: "sign-2", notCounted: true },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("TILL_ALREADY_SIGNED");
    const rows = await pool.query("SELECT count(*)::int AS n FROM ledger_till_signoffs");
    expect(rows.rows[0].n).toBe(1);
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_audit_events WHERE action = 'till.signoff'",
    );
    expect(audit.rows[0].n).toBe(1);
    const seen = await read("r.haddad");
    expect(seen.statusCode).toBe(200);
    expect(seen.json().signoff.signoffId).toBe(first.json().signoffId);
    expect(seen.json().preview).toBeNull();
    const pdf = await app.inject({
      method: "GET",
      url: "/api/ledger/close-of-day/pdf",
      cookies: await cookie("r.haddad"),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const text = pdf.body;
    expect(text.startsWith("%PDF")).toBe(true);
    expect(text).toContain("York FX Canada");
    expect(text).toContain("Teller");
    expect(text).toContain("Owner");
    expect(text).toContain("/MediaBox [0 0 595 842]");
  });

  it("counts 10,000.00 and 10,000.01 and leaves 9,999.99 off", async () => {
    await hold("USD", "100000.00", "1.400000");
    await hold("CAD", "50000.00", null);
    await postDeal("9999.99", "line-under");
    await postDeal("10000.00", "line-on");
    await postDeal("10000.01", "line-over");
    const preview = await read();
    expect(preview.statusCode).toBe(200);
    const snap = preview.json().preview;
    expect(snap.singleDeals).toBe(2);
    expect(snap.reportingComparator).toBe("gte");
    expect(snap.reportingLine).toBe("10000.00");
  });

  it("counts 6,000 plus 4,500 for one customer as an LCTR", async () => {
    await hold("USD", "100000.00", "1.400000");
    await hold("CAD", "20000.00", null);
    await postDeal("6000.00", "lctr-a");
    await postDeal("4500.00", "lctr-b");
    const snap = (await read()).json().preview;
    expect(snap.singleDeals).toBe(0);
    expect(snap.lctrCustomers).toBe(1);
  });

  it("counts a customer whose ID is not verified", async () => {
    await hold("USD", "1000.00", "1.400000");
    await hold("CAD", "1000.00", null);
    await pool.query(
      "INSERT INTO ledger_customers VALUES ('customer-gap',$1,$2,$3,$4,'No Papers','Normal','missing')",
      scope.slice(0, 4),
    );
    await postDeal("20.00", "gap-deal", "customer-gap");
    const snap = (await read()).json().preview;
    expect(snap.clientsMissingId).toBe(1);
  });

  it("returns the drawer sum from the count, and earnings that include the margin", async () => {
    await hold("USD", "1000.00", "1.400000");
    await hold("CAD", "500.00", null);
    const before = (await read()).json().preview;
    expect(before.notCounted).toBe(true);
    expect(before.drawerHome).toBeNull();
    const cookies = await cookie("r.haddad");
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies,
      payload: {
        idempotencyKey: "count-drawer",
        counts: { CAD: "500.00", USD: "1000.00" },
      },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const after = (await read()).json().preview;
    expect(after.notCounted).toBe(false);
    /* 500 CAD at par, 1,000 USD at 1.4 per CAD. The screen is not asked to add this. */
    expect(after.drawerHome).toBe("1214.29");
    await postDeal("1443.30", "margin-deal");
    const earned = (await read()).json().preview;
    expect(earned.feesHome).not.toBe(earned.earningsHome);
    expect(earned.realizedPnlHome).not.toBeNull();
    expect(Number(earned.earningsHome)).toBeGreaterThan(Number(earned.feesHome));
    expect(earned.volumeByCurrency.map((row: { currency: string }) => row.currency)).toContain("CAD");
  });
});
