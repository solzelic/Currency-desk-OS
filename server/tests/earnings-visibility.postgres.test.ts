/* Teller vs owner on the reads that return the book's take.
   Close-day is till:close. report:earnings is the other door and no
   role holds it. A teller, an auditor, and a compliance officer are
   redacted. A supervisor and a branch manager close the day and see
   the figures. The customer-facing fee stays with the teller. */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
const SHOP = [
  "earningsHome", "realizedPnlHome", "costOfSaleHome", "spreadCad", "unrealizedPnlHome",
  "costBasisHome", "marketValueHome", "marketUnitHome", "avgCost", "marketMid", "fromMid", "toMid",
];

async function cookie(staffId: string) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value };
}
const read = async (staffId: string, path: string) =>
  (await app.inject({ method: "GET", url: path, cookies: await cookie(staffId) })).json();
const lacks = (value: unknown, keys: string[]) => {
  const body = JSON.stringify(value);
  for (const key of keys) expect(body).not.toContain(`"${key}"`);
};

postgres("tellers keep the customer fee and do not receive shop earnings", () => {
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
    /* A 1,000 business cheque is 35.00 on this schedule, so fees stay 39.00. */
    const schedule = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) =>
      row.id === "business" ? { ...row, feePct: 3.5, feeMin: 0 } : row));
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    await pool.query(
      "INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)",
      [DEMO.tenantId, JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: schedule })],
    );
    app = await buildApp(handle.db);
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE");
    for (const [staffId, role] of [["j.masri", "administrator"], ["m.costa", "teller"], ["a.singh", "supervisor"], ["r.haddad", "branch_manager"]] as const) {
      await handle.db.update(schema.staffUsers).set({ role, authorizedBranchIds: [DEMO.branchId] }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staffId}`));
    }
    await pool.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
    await pool.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool.query("INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING", [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId]);
    await pool.query("INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')", scope.slice(0, 4));
    await pool.query(
      `INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount,avg_cost)
       VALUES ($1,$2,$3,$4,$5,'CAD',50000,NULL),($1,$2,$3,$4,$5,'USD',4000,'1.340000000000')`,
      scope,
    );
    await pool.query(
      `INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at)
       VALUES ('earn-session',$1,$2,$3,$4,$5,1,current_date,'open',$1||':j.masri',now())`,
      scope,
    );
    await pool.query("INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('earn-snap','test','{\"USD\":1.4}',now())");
    await pool.query(
      "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.714285714286)",
      scope.slice(0, 4),
    );
    await pool.query(
      `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
       VALUES ('earn-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','earn-snap',now())`,
      scope.slice(0, 3),
    );
  });

  it("keeps the customer fee and strips the shop's take from a teller", async () => {
    const owner = await cookie("j.masri");
    const quote = (await app.inject({
      method: "POST", url: "/api/quotes", cookies: owner,
      payload: { customerId: "customer-demo", from: "CAD", to: "USD", inputAmount: "1443.30", feeCad: "4.00", direction: "customer_buy_foreign" },
    })).json();
    const posted = await app.inject({
      method: "POST", url: `/api/quotes/${quote.quoteId}/post`, cookies: owner,
      payload: { idempotencyKey: "earn-one", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().spreadCad).toEqual(expect.any(String));
    expect(posted.json().marketMid).toEqual(expect.any(String));
    const transactionId = posted.json().transactionId as string;
    const cashed = await app.inject({
      method: "POST", url: "/api/ledger/cheques", cookies: owner,
      payload: {
        idempotencyKey: "earn-cheque", customerId: "customer-demo", chequeNumber: "004821",
        maker: "Northbridge Imports Ltd.", draweeBank: "RBC Royal Bank", chequeType: "business",
        typeLabel: "Business", currency: "CAD", faceAmount: "1000.00", feeAmount: "35.00", holdDays: 3, endorsed: true,
      },
    });
    expect(cashed.statusCode, cashed.body).toBe(201);

    const tellerSummary = await read("m.costa", "/api/ledger/summary");
    const ownerSummary = await read("j.masri", "/api/ledger/summary");
    const supervisorSummary = await read("a.singh", "/api/ledger/summary");
    expect(tellerSummary.volumeHome).toBe("2443.30");
    expect(tellerSummary.feesHome).toBe("39.00");
    lacks(tellerSummary, ["earningsHome", "realizedPnlHome", "costOfSaleHome"]);
    expect(tellerSummary.byActor.length).toBeGreaterThan(0);
    for (const row of tellerSummary.byActor) lacks(row, ["feesHome", "earningsHome", "realizedPnlHome"]);
    for (const row of tellerSummary.byCurrency) lacks(row, ["realizedPnlHome"]);
    expect(ownerSummary).toMatchObject({ feesHome: "39.00" });
    expect(ownerSummary.earningsHome).not.toBeNull();
    expect(ownerSummary.byActor.some((row: { earningsHome: string | null }) => row.earningsHome != null)).toBe(true);
    expect(supervisorSummary.feesHome).toBe(ownerSummary.feesHome);
    expect(supervisorSummary.earningsHome).toBe(ownerSummary.earningsHome);
    expect(supervisorSummary.byActor).toEqual(ownerSummary.byActor);

    const tellerTx = await read("m.costa", "/api/ledger/transactions?limit=20");
    const ownerTx = await read("j.masri", "/api/ledger/transactions?limit=20");
    const deal = ownerTx.transactions.find((row: { transactionId: string }) => row.transactionId === transactionId);
    const tellerDeal = tellerTx.transactions.find((row: { transactionId: string }) => row.transactionId === transactionId);
    expect(deal).toMatchObject({ feeCad: "4.00", realizedPnlHome: "103.30" });
    expect(deal.spreadCad).toEqual(expect.any(String));
    expect(deal.marketMid).toEqual(expect.any(String));
    expect(tellerDeal).toMatchObject({ inputAmount: "1443.30", feeCad: "4.00" });
    lacks(tellerDeal, ["spreadCad", "costOfSaleHome", "realizedPnlHome", "marketMid"]);

    const tellerReceipt = await read("m.costa", `/api/ledger/transactions/${transactionId}/receipt`);
    const ownerReceipt = await read("j.masri", `/api/ledger/transactions/${transactionId}/receipt`);
    expect(ownerReceipt.lines.join("\n")).toContain("Fee paid separately");
    expect(tellerReceipt.lines.join("\n")).toContain("Fee paid separately: CAD 4.00");

    const tellerPosition = await read("m.costa", "/api/ledger/position");
    const ownerPosition = await read("j.masri", "/api/ledger/position");
    expect(JSON.stringify(ownerPosition)).toContain("unrealizedPnlHome");
    expect(JSON.stringify(ownerPosition)).toContain("costBasisHome");
    expect(JSON.stringify(ownerPosition)).toContain("marketValueHome");
    const tellerUsd = tellerPosition.currencies.find((row: { currency: string }) => row.currency === "USD");
    const ownerUsd = ownerPosition.currencies.find((row: { currency: string }) => row.currency === "USD");
    expect(tellerUsd.quantity).toMatch(/^\d+\.\d{2}$/);
    expect(tellerUsd.till.quantity).toMatch(/^\d+\.\d{2}$/);
    lacks(tellerPosition, ["unrealizedPnlHome", "costBasisHome", "marketValueHome", "marketUnitHome", "avgCost"]);
    expect(ownerUsd.costBasisHome).toEqual(expect.any(String));
    expect(ownerUsd.marketValueHome).toEqual(expect.any(String));
    expect(ownerUsd.marketUnitHome).toEqual(expect.any(String));
    expect(ownerUsd.till.avgCost).toEqual(expect.any(String));

    const tellerCheques = await read("m.costa", "/api/ledger/cheques");
    const ownerCheques = await read("j.masri", "/api/ledger/cheques");
    expect(ownerCheques.cheques[0].feeAmount).toBe("35.00");
    expect(tellerCheques.cheques[0]).toMatchObject({ faceAmount: "1000.00", feeAmount: "35.00" });

    const tellerQuote = await read("m.costa", `/api/quotes/${quote.quoteId}`);
    const ownerQuote = await read("j.masri", `/api/quotes/${quote.quoteId}`);
    const managerQuote = await read("r.haddad", `/api/quotes/${quote.quoteId}`);
    expect(tellerQuote).toMatchObject({ status: "posted", feeCad: "4.00" });
    lacks(tellerQuote, ["spreadCad", "marketMid", "fromMid", "toMid"]);
    expect(ownerQuote.spreadCad).toEqual(expect.any(String));
    expect(ownerQuote.marketMid).toEqual(expect.any(String));
    expect(managerQuote.spreadCad).toBe(ownerQuote.spreadCad);
    expect(managerQuote.marketMid).toBe(ownerQuote.marketMid);

    const teller = await cookie("m.costa");
    const live = (await app.inject({
      method: "POST", url: "/api/quotes", cookies: teller,
      payload: { customerId: "customer-demo", from: "CAD", to: "USD", inputAmount: "200.00", feeCad: "4.00", direction: "customer_buy_foreign" },
    })).json();
    expect(live.status).toBe("active");
    expect(live.spreadCad).toEqual(expect.any(String));
    const liveRead = await read("m.costa", `/api/quotes/${live.quoteId}`);
    expect(liveRead).toMatchObject({ status: "active", spreadCad: live.spreadCad, feeCad: "4.00" });
    const cancelled = await app.inject({ method: "POST", url: `/api/quotes/${live.quoteId}/cancel`, cookies: teller });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "cancelled", feeCad: "4.00" });
    lacks(cancelled.json(), ["spreadCad", "marketMid", "fromMid", "toMid"]);

    const managerLive = (await app.inject({
      method: "POST", url: "/api/quotes", cookies: await cookie("r.haddad"),
      payload: { customerId: "customer-demo", from: "CAD", to: "USD", inputAmount: "150.00", feeCad: "4.00", direction: "customer_buy_foreign" },
    })).json();
    const managerCancel = await app.inject({
      method: "POST", url: `/api/quotes/${managerLive.quoteId}/cancel`, cookies: await cookie("r.haddad"),
    });
    expect(managerCancel.statusCode, managerCancel.body).toBe(200);
    expect(managerCancel.json().spreadCad).toBe(managerLive.spreadCad);

    await pool.query("UPDATE ledger_till_sessions SET opened_by=$1 WHERE status='open'", [`${DEMO.tenantId}:m.costa`]);
    const tellerMade = (await app.inject({
      method: "POST", url: "/api/quotes", cookies: teller,
      payload: { customerId: "customer-demo", from: "CAD", to: "USD", inputAmount: "300.00", feeCad: "4.00", direction: "customer_buy_foreign" },
    })).json();
    const tellerPost = await app.inject({
      method: "POST", url: `/api/quotes/${tellerMade.quoteId}/post`, cookies: teller,
      payload: { idempotencyKey: "earn-teller-post", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(tellerPost.statusCode, tellerPost.body).toBe(201);
    expect(tellerPost.json()).toMatchObject({ feeCad: "4.00", quoteId: tellerMade.quoteId });
    lacks(tellerPost.json(), ["spreadCad", "marketMid", "fromMid", "toMid"]);
    expect(tellerPost.json().receipt.lines.join("\n")).toContain("Fee paid separately: CAD 4.00");
    const tellerReplay = await app.inject({
      method: "POST", url: `/api/quotes/${tellerMade.quoteId}/post`, cookies: teller,
      payload: { idempotencyKey: "earn-teller-post", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    lacks(tellerReplay.json(), ["spreadCad", "marketMid"]);
    const ownerReplay = await app.inject({
      method: "POST", url: `/api/quotes/${tellerMade.quoteId}/post`, cookies: owner,
      payload: { idempotencyKey: "earn-teller-post", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(ownerReplay.json().spreadCad).toEqual(expect.any(String));

    const leaked = JSON.stringify({
      tellerSummary, tellerTx, tellerReceipt, tellerPosition, tellerCheques, tellerQuote,
      tellerPost: tellerPost.json(), tellerCancel: cancelled.json(),
    });
    lacks(JSON.parse(leaked), SHOP);
    expect(leaked).not.toContain("107.30");
    expect(leaked).not.toContain("103.30");
    expect(leaked).toContain("4.00");
    expect(leaked).toContain("35.00");
  });

  it("redacts an auditor and a compliance officer, and leaves close-day figures", async () => {
    await pool.query("UPDATE ledger_till_sessions SET opened_by=$1 WHERE status='open'", [`${DEMO.tenantId}:j.masri`]);
    const setRole = (staffId: string, role: "auditor" | "compliance_officer") =>
      handle.db.update(schema.staffUsers).set({ role, authorizedBranchIds: [DEMO.branchId] }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:${staffId}`));
    await setRole("s.iqbal", "auditor");
    await setRole("m.costa", "compliance_officer");

    const owner = await cookie("j.masri");
    const quote = (await app.inject({
      method: "POST", url: "/api/quotes", cookies: owner,
      payload: { customerId: "customer-demo", from: "CAD", to: "USD", inputAmount: "1443.30", feeCad: "4.00", direction: "customer_buy_foreign" },
    })).json();
    const posted = await app.inject({
      method: "POST", url: `/api/quotes/${quote.quoteId}/post`, cookies: owner,
      payload: { idempotencyKey: "earn-roles", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(posted.statusCode, posted.body).toBe(201);

    const ownerSummary = await read("j.masri", "/api/ledger/summary");
    const ownerDeal = (await read("j.masri", "/api/ledger/transactions?limit=20")).transactions[0];
    const ownerQuote = await read("j.masri", `/api/quotes/${quote.quoteId}`);
    expect(ownerSummary.earningsHome).toEqual(expect.any(String));
    expect(ownerDeal.marketMid).toEqual(expect.any(String));
    expect(ownerQuote.spreadCad).toEqual(expect.any(String));

    for (const staffId of ["s.iqbal", "m.costa"] as const) {
      const summary = await read(staffId, "/api/ledger/summary");
      const deal = (await read(staffId, "/api/ledger/transactions?limit=20")).transactions[0];
      const position = await read(staffId, "/api/ledger/position");
      const quoteRead = await read(staffId, `/api/quotes/${quote.quoteId}`);
      expect(summary.feesHome).toBe(ownerSummary.feesHome);
      lacks(summary, ["earningsHome", "realizedPnlHome", "costOfSaleHome"]);
      lacks(deal, ["spreadCad", "marketMid", "realizedPnlHome", "costOfSaleHome"]);
      lacks(position, ["costBasisHome", "marketValueHome", "marketUnitHome", "avgCost", "unrealizedPnlHome"]);
      expect(position.currencies.find((row: { currency: string }) => row.currency === "USD").quantity).toMatch(/^\d+\.\d{2}$/);
      expect(quoteRead).toMatchObject({ status: "posted", feeCad: "4.00" });
      lacks(quoteRead, ["spreadCad", "marketMid"]);
    }

    for (const staffId of ["a.singh", "r.haddad"] as const) {
      const summary = await read(staffId, "/api/ledger/summary");
      const deal = (await read(staffId, "/api/ledger/transactions?limit=20")).transactions[0];
      const position = await read(staffId, "/api/ledger/position");
      const quoteRead = await read(staffId, `/api/quotes/${quote.quoteId}`);
      expect(summary.earningsHome).toBe(ownerSummary.earningsHome);
      expect(summary.realizedPnlHome).toBe(ownerSummary.realizedPnlHome);
      expect(deal.spreadCad).toBe(ownerDeal.spreadCad);
      expect(deal.marketMid).toBe(ownerDeal.marketMid);
      expect(deal.realizedPnlHome).toBe(ownerDeal.realizedPnlHome);
      const usd = position.currencies.find((row: { currency: string }) => row.currency === "USD");
      expect(usd.costBasisHome).toEqual(expect.any(String));
      expect(usd.marketValueHome).toEqual(expect.any(String));
      expect(quoteRead.spreadCad).toBe(ownerQuote.spreadCad);
      expect(quoteRead.marketMid).toBe(ownerQuote.marketMid);
    }
  });
});
