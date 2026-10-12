/* Teller vs owner on the reads that return the book's take.
   Close-day is till:close. The earnings report is report:earnings.
   A teller has neither. An owner has both. A supervisor has till:close only.
   The customer-facing fee stays with the teller. The shop's take does not. */
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
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, "till-01"];
const SHOP = ["earningsHome", "realizedPnlHome", "costOfSaleHome", "spreadCad", "unrealizedPnlHome"];

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

postgres("tellers do not receive fees or earnings", () => {
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
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE");
    for (const [staffId, role] of [["j.masri", "administrator"], ["m.costa", "teller"], ["a.singh", "supervisor"]] as const) {
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
    expect(tellerDeal).toMatchObject({ inputAmount: "1443.30", feeCad: "4.00" });
    lacks(tellerDeal, ["spreadCad", "costOfSaleHome", "realizedPnlHome"]);

    const tellerReceipt = await read("m.costa", `/api/ledger/transactions/${transactionId}/receipt`);
    const ownerReceipt = await read("j.masri", `/api/ledger/transactions/${transactionId}/receipt`);
    expect(ownerReceipt.lines.join("\n")).toContain("Fee paid separately");
    expect(tellerReceipt.lines.join("\n")).toContain("Fee paid separately: CAD 4.00");

    const tellerPosition = await read("m.costa", "/api/ledger/position");
    const ownerPosition = await read("j.masri", "/api/ledger/position");
    expect(JSON.stringify(ownerPosition)).toContain("unrealizedPnlHome");
    lacks(tellerPosition, ["unrealizedPnlHome"]);

    const tellerCheques = await read("m.costa", "/api/ledger/cheques");
    const ownerCheques = await read("j.masri", "/api/ledger/cheques");
    expect(ownerCheques.cheques[0].feeAmount).toBe("35.00");
    expect(tellerCheques.cheques[0]).toMatchObject({ faceAmount: "1000.00", feeAmount: "35.00" });

    const leaked = JSON.stringify({ tellerSummary, tellerTx, tellerReceipt, tellerPosition, tellerCheques });
    lacks(JSON.parse(leaked), SHOP);
    expect(leaked).not.toContain("107.30");
    expect(leaked).not.toContain("103.30");
    expect(leaked).toContain("4.00");
    expect(leaked).toContain("35.00");
  });
});
