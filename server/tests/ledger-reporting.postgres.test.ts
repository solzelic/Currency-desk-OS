/* ============================================================
   The figures a summary screen puts in front of an owner.

   None of these reads move money, and that is exactly why they were the
   last thing on this product to reach the ledger: a wrong balance gets
   found the moment somebody counts the drawer, and a wrong dashboard
   just sits there being believed. The Dashboard reported 38 deals and
   $130,566 of volume for a desk that had done one $1,000 trade, and
   nothing anywhere disagreed with it.

   So each case below asks the endpoint a question with a knowable answer
   and checks it against what was actually posted — including the answers
   that are supposed to be ABSENT. A period with nothing in it must not
   report zero; a currency whose basis nobody recorded must not report a
   cost; a total that would have to guess at one of its rows must not be
   offered at all. Those are the assertions that stop "—" from quietly
   becoming "$0.00" again.
   ============================================================ */
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

async function cookie(staffId = "r.haddad") {
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
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
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
     VALUES ('report-session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':r.haddad',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('report-snap','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('report-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','report-snap',now())`,
    scope.slice(0, 3),
  );
}

/** Cash in the drawer, optionally with a basis the desk can explain. */
async function tillHolds(currency: string, amount: number, avgCost?: string) {
  await pool.query(
    `INSERT INTO ledger_till_balances
      (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount,avg_cost)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [...scope, currency, amount, avgCost ?? null],
  );
}

/** The desk's own published board, in units per Canadian dollar. */
async function publishBoard(rows: Record<string, number>) {
  for (const [currency, unitsPerCad] of Object.entries(rows)) {
    await pool.query(
      "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [...scope.slice(0, 4), currency, unitsPerCad],
    );
  }
}

/**
 * One real deal, through the same frozen-quote path a teller uses.
 *
 * 1,443.30 CAD at the board's 1.40 mid and 3% sell margin buys exactly a
 * thousand US dollars, which keeps every figure below a round number
 * instead of a string of rounding remainders.
 */
async function sellAThousandDollars(idempotencyKey: string, feeCad = "4.00") {
  const cookies = await cookie();
  const quote = (
    await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies,
      payload: {
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "1443.30",
        feeCad,
        direction: "customer_buy_foreign",
      },
    })
  ).json();
  expect(quote.outputAmount).toBe("1000.00");
  const posted = await app.inject({
    method: "POST",
    url: `/api/quotes/${quote.quoteId}/post`,
    cookies,
    payload: {
      idempotencyKey,
      purpose: "Personal travel",
      sourceOfFunds: "Employment income",
    },
  });
  expect(posted.statusCode).toBe(201);
  return posted.json().transactionId as string;
}

const summary = async (query = "") =>
  (
    await app.inject({
      method: "GET",
      url: `/api/ledger/summary${query}`,
      cookies: await cookie(),
    })
  ).json();

const position = async () =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/position",
      cookies: await cookie(),
    })
  ).json();

postgres("the ledger answers for its own headline figures", () => {
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

  beforeEach(reset);

  /* THE ONE THAT MATTERS MOST. A desk that has posted nothing has no
     volume, no fees and no earnings — and "no earnings" is not "$0.00
     earned". The browser's answer to this question was $1,150, and it
     was the first thing an owner saw. */
  it("reports nothing as absent, not as zero", async () => {
    const empty = await summary();
    expect(empty.posted).toBe(0);
    expect(empty.reversed).toBe(0);
    expect(empty.volumeHome).toBeNull();
    expect(empty.feesHome).toBeNull();
    expect(empty.realizedPnlHome).toBeNull();
    expect(empty.earningsHome).toBeNull();
    expect(empty.byCurrency).toEqual([]);
  });

  it("counts one deal as one deal, at what it was actually worth", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    await sellAThousandDollars("summary-one");

    const one = await summary();
    expect(one.posted).toBe(1);
    expect(one.reversed).toBe(0);
    expect(one.volumeHome).toBe("1443.30");
    expect(one.feesHome).toBe("4.00");
    expect(one.unvaluedDeals).toBe(0);
    // 1,443.30 taken in against 1,000 USD that cost 1.34 apiece
    expect(one.realizedPnlHome).toBe("103.30");
    expect(one.costOfSaleHome).toBe("1340.00");
    expect(one.earningsHome).toBe("107.30");
    expect(one.pricedDeals).toBe(1);
    expect(one.byCurrency).toEqual([
      {
        currency: "USD",
        deals: 1,
        sold: "1000.00",
        realizedPnlHome: "103.30",
        pricedDeals: 1,
      },
    ]);
  });

  /* A void is a deal that did not happen. Rolling it into the totals as a
     zero would let a morning of mistakes read as a busy morning, and
     leaving it out of the counts entirely would hide that anything was
     undone — so it comes out of the money and stays in the tally. */
  it("takes a reversed deal back out of every total", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    const transactionId = await sellAThousandDollars("summary-void");
    expect((await summary()).posted).toBe(1);

    const reversal = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${transactionId}/reversal`,
      cookies: await cookie(),
      payload: { idempotencyKey: "summary-void-rev", reason: "Wrong customer" },
    });
    expect(reversal.statusCode).toBe(201);

    const after = await summary();
    expect(after.posted).toBe(0);
    expect(after.reversed).toBe(1);
    expect(after.volumeHome).toBeNull();
    expect(after.realizedPnlHome).toBeNull();
    expect(after.byCurrency).toEqual([]);
  });

  it("only totals the window it was asked for", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    await sellAThousandDollars("summary-window");

    const future = "2099-01-01T00:00:00.000Z";
    const later = await summary(`?from=${encodeURIComponent(future)}`);
    expect(later.posted).toBe(0);
    expect(later.volumeHome).toBeNull();

    const upToNow = await summary(
      `?to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
    );
    expect(upToNow.posted).toBe(1);
  });

  it("puts the till and the vault side by side without adding a currency neither holds", async () => {
    await tillHolds("CAD", 25000);
    await tillHolds("USD", 4000, "1.340000000000");
    await pool.query(
      `INSERT INTO ledger_vault_balances
        (tenant_id,legal_entity_id,branch_id,currency,available_amount,avg_cost)
       VALUES ($1,$2,$3,'USD',6000,'1.440000000000')`,
      scope.slice(0, 3),
    );
    await publishBoard({ CAD: 1, USD: 0.714285714286 });

    const held = await position();
    expect(held.tillTracked).toBe(true);
    expect(held.vaultTracked).toBe(true);
    expect(held.currencies.map((c: { currency: string }) => c.currency)).toEqual([
      "CAD",
      "USD",
    ]);

    const usd = held.currencies.find((c: { currency: string }) => c.currency === "USD");
    expect(usd.quantity).toBe("10000.00");
    expect(usd.till).toMatchObject({ quantity: "4000.00" });
    expect(usd.vault).toMatchObject({ quantity: "6000.00" });
    // 4,000 at 1.34 plus 6,000 at 1.44
    expect(usd.costBasisHome).toBe("14000.00");
    expect(usd.unpricedQuantity).toBe("0.00");
    // 10,000 USD at the board's 1.40
    expect(usd.marketValueHome).toBe("14000.00");
    expect(usd.unrealizedPnlHome).toBe("0.00");

    /* The home currency is the unit everything else is measured in. It
       never carries an average and never shows a gain against itself. */
    const cad = held.currencies.find((c: { currency: string }) => c.currency === "CAD");
    expect(cad.costBasisHome).toBe("25000.00");
    expect(cad.unrealizedPnlHome).toBeNull();

    /* Each box carries its own headline, because the Vault screen is
       asking about the safe and the Cash Drawer about the drawer. The
       safe holds 6,000 USD at 1.44 and no CAD at all. */
    expect(held.vaultTotals).toEqual({
      currencies: 1,
      marketValueHome: "8400.00",
      costBasisHome: "8640.00",
      unrealizedPnlHome: "-240.00",
    });
    expect(held.tillTotals.marketValueHome).toBe("30600.00");
  });

  /* The Vault used to print "Unrealized P&L +$4,813.65" over currencies
     whose avg_cost is NULL on this server. There is no honest number to
     put there, and this is the assertion that keeps one from appearing. */
  it("refuses to price a holding whose basis nobody recorded", async () => {
    await tillHolds("CAD", 25000);
    await tillHolds("USD", 4000); // arrived before cost tracking: no basis
    await publishBoard({ CAD: 1, USD: 0.714285714286 });

    const held = await position();
    const usd = held.currencies.find((c: { currency: string }) => c.currency === "USD");
    expect(usd.till.avgCost).toBeNull();
    expect(usd.unpricedQuantity).toBe("4000.00");
    expect(usd.costBasisHome).toBeNull();
    // the market half IS known, and saying so is not the same as pricing it
    expect(usd.marketValueHome).toBe("5600.00");
    expect(usd.unrealizedPnlHome).toBeNull();

    // and a total that would have to guess at one of its rows is not offered
    expect(held.costBasisHome).toBeNull();
    expect(held.unpricedCurrencies).toEqual(["USD"]);
    expect(held.marketValueHome).toBe("30600.00");
  });

  it("says the market value is unknown for a currency the branch never published", async () => {
    await tillHolds("CAD", 25000);
    await tillHolds("EUR", 3000, "1.500000000000");
    await publishBoard({ CAD: 1 });

    const held = await position();
    const eur = held.currencies.find((c: { currency: string }) => c.currency === "EUR");
    expect(eur.costBasisHome).toBe("4500.00");
    expect(eur.marketUnitHome).toBeNull();
    expect(eur.marketValueHome).toBeNull();
    expect(eur.unrealizedPnlHome).toBeNull();
    expect(held.marketValueHome).toBeNull();
    expect(held.unvaluedCurrencies).toEqual(["EUR"]);
  });

  it("distinguishes a box holding nothing from a box nobody declared", async () => {
    const untouched = await position();
    expect(untouched.tillTracked).toBe(false);
    expect(untouched.vaultTracked).toBe(false);
    expect(untouched.currencies).toEqual([]);
    expect(untouched.marketValueHome).toBeNull();
    expect(untouched.costBasisHome).toBeNull();
  });

  /* The reporting line is the desk's, in the desk's money. The browser
     hardcoded 10,000 Canadian dollars and flagged at that number on two
     screens while Compliance flagged at the owner's setting on three
     others — the same desk, two different lines. */
  it("hands the client the jurisdiction pack it actually trades under", async () => {
    const answer = (
      await app.inject({
        method: "GET",
        url: "/api/ledger/jurisdiction",
        cookies: await cookie(),
      })
    ).json();
    expect(answer.pack).toMatchObject({
      packId: "pack-ca-v1",
      homeCurrency: "CAD",
      reportName: "LCTR",
      reportThreshold: "10000.00",
      reportCurrency: "CAD",
    });
  });

  it("refuses all three reads to a session that is not signed in", async () => {
    for (const path of ["summary", "position", "jurisdiction"]) {
      const answer = await app.inject({ method: "GET", url: `/api/ledger/${path}` });
      expect(answer.statusCode).toBe(401);
    }
  });
});
