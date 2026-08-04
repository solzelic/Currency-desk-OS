/* ============================================================
   Where the cost engine meets everything else.

   The engine decides what a disposal cost. Two callers used to decide it
   again for themselves, off the box's running average, and under weighted
   average that is the same number so nobody could tell:

     the customer-sale journal, which wrote `output × avg_cost` and posted
     it before the disposal had even happened; and

     a transfer between the desk's own boxes, which took the cost OUT of
     the sending box under the desk's method and put it INTO the receiving
     box at the sending box's average.

   Under FIFO those figures diverge. The first makes `ledger_cost_events`
   and `ledger_journal_entries` disagree about the same sale — two books
   again. The second changes the book value of inventory while cash walks
   down a corridor between two safes the desk owns, which is money being
   invented or destroyed by a float.

   Both tests below fail against a journal that prices for itself.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
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

const MONDAY = new Date("2026-08-03T10:00:00Z");
const WEDNESDAY = new Date("2026-08-05T10:00:00Z");

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
  // FIFO on. Everything here is about the figures the two methods disagree on.
  await pool.query("UPDATE legal_entities SET cost_method='fifo' WHERE id=$1", [
    DEMO.legalEntityId,
  ]);
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
  for (const [currency, amount] of [
    ["CAD", 50000],
    ["USD", 4000],
  ] as const)
    await pool.query(
      "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, amount],
    );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('fifo-session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':r.haddad',now())`,
    scope,
  );
  await pool.query(
    "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.714285714286) ON CONFLICT DO NOTHING",
    scope.slice(0, 4),
  );
  await pool.query(
    "INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('fifo-snap','test','{\"USD\":1.4}',now())",
  );
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('fifo-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','fifo-snap',now())`,
    scope.slice(0, 3),
  );
}

/**
 * Two lots in the drawer at prices a fortnight apart, and the running
 * average they blend to.
 *
 *   Monday      2,000 USD at 1.34
 *   Wednesday   2,000 USD at 1.42
 *   average                  1.38
 *
 * FIFO sells Monday's first. A journal pricing off the average would cost
 * the same units at 1.38 — 40 CAD a thousand adrift, in the desk's favour
 * or against it depending on which way the market moved.
 */
async function twoLots(location: { kind: "till" | "vault"; id: string }) {
  for (const [unitCost, at] of [
    ["1.340000000000", MONDAY],
    ["1.420000000000", WEDNESDAY],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_cost_lots
        (lot_id,tenant_id,legal_entity_id,branch_id,location_kind,location_id,
         currency,quantity,unit_cost_home,remaining_quantity,acquired_at,event_id)
       VALUES ($1,$2,$3,$4,$5,$6,'USD',2000,$7,2000,$8,NULL)`,
      [
        `lot-${location.id}-${at.getTime()}`,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        location.kind,
        location.id,
        unitCost,
        at,
      ],
    );
  }
}

const journalOf = async (transactionId: string) =>
  (
    await pool.query(
      "SELECT account_code,side,amount_cad FROM ledger_journal_entries WHERE transaction_id=$1 ORDER BY entry_id",
      [transactionId],
    )
  ).rows as { account_code: string; side: string; amount_cad: string }[];

const lotsAt = async (locationId: string) =>
  (
    await pool.query(
      `SELECT unit_cost_home, remaining_quantity FROM ledger_cost_lots
        WHERE location_id=$1 AND currency='USD' ORDER BY acquired_at, lot_id`,
      [locationId],
    )
  ).rows as { unit_cost_home: string; remaining_quantity: string }[];

/** What the open lots in a box are carried at, in home currency. */
const bookValue = async (locationId: string) =>
  (await lotsAt(locationId)).reduce(
    (total, row) =>
      total.add(new Decimal(row.remaining_quantity).mul(row.unit_cost_home)),
    new Decimal(0),
  );

postgres("the journal says what the disposal actually cost", () => {
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
    await pool.query("UPDATE legal_entities SET cost_method=NULL");
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(reset);

  it("posts a customer sale at the FIFO cost, in the journal as well as the events", async () => {
    await twoLots({ kind: "till", id: TILL });
    await pool.query(
      "UPDATE ledger_till_balances SET avg_cost='1.380000000000' WHERE till_id=$1 AND currency='USD'",
      [TILL],
    );
    const cookies = await cookie();

    /* The customer buys US dollars with home currency, so the desk DISPOSES
       of USD. A quote is priced off what the customer hands over, and at
       1.40 with the board's 3% sell margin 1,443.30 CAD buys exactly a
       thousand dollars — which is what makes the cost arithmetic below
       readable rather than a string of rounded remainders. */
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
          feeCad: "4.00",
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
        idempotencyKey: "fifo-sale-1",
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      },
    });
    expect(posted.json()).toMatchObject({ transactionId: expect.any(String) });
    expect(posted.statusCode).toBe(201);
    const transactionId = posted.json().transactionId;

    /* The engine's answer: Monday's dollars, at 1.34. Not the drawer's
       1.38 average, which is what both books used to say. */
    const event = (
      await pool.query(
        `SELECT quantity, unit_cost_home, proceeds_home, realized_pnl_home, cost_method
           FROM ledger_cost_events
          WHERE source_id=$1 AND event_kind='sale'`,
        [transactionId],
      )
    ).rows[0];
    expect(event.cost_method).toBe("fifo");
    expect(new Decimal(event.unit_cost_home).toFixed(2)).toBe("1.34");
    const costOfSale = new Decimal(event.quantity).mul(event.unit_cost_home);
    expect(costOfSale.toFixed(2)).toBe("1340.00");
    const realized = new Decimal(event.proceeds_home).minus(costOfSale);

    /* Same figure in the journal. A stock credit off the average would read
       1,380.00 here and the two books would differ by 40 on one deal, with
       nothing anywhere complaining. */
    const journal = await journalOf(transactionId);
    const stockOut = journal.find(
      (row) => row.account_code === "till:USD" && row.side === "credit",
    )!;
    expect(stockOut.amount_cad).toBe("1340.00");
    const trading = journal.find(
      (row) => row.account_code === "revenue:fx_trading",
    )!;
    expect(new Decimal(trading.amount_cad).toFixed(2)).toBe(
      realized.abs().toFixed(2),
    );
    expect(trading.side).toBe(realized.gte(0) ? "credit" : "debit");

    // and the transaction row a report reads, which is a third copy of it
    const row = (
      await pool.query(
        "SELECT realized_pnl_home, cost_of_sale_home FROM ledger_transactions WHERE transaction_id=$1",
        [transactionId],
      )
    ).rows[0];
    expect(row.cost_of_sale_home).toBe("1340.00");
    expect(new Decimal(row.realized_pnl_home).toFixed(2)).toBe(
      realized.toFixed(2),
    );

    // the journal still balances, which is the thing that must never break
    const total = (side: string) =>
      journal
        .filter((entry) => entry.side === side)
        .reduce((sum, entry) => sum.add(entry.amount_cad), new Decimal(0));
    expect(total("debit").toFixed(2)).toBe(total("credit").toFixed(2));

    // Monday's lot is spent down and Wednesday's is untouched
    expect((await lotsAt(TILL)).map((r) => r.remaining_quantity)).toEqual([
      "1000.00",
      "2000.00",
    ]);
  });

  it("floats cash between the desk's own boxes without changing what it is worth", async () => {
    /* A vault's cost box is keyed by the branch itself — one strong room per
       branch — while the movement names it `<branch>:vault`. Two different
       identifiers for the same safe. */
    const vaultId = DEMO.branchId;
    await twoLots({ kind: "vault", id: vaultId });
    await pool.query(
      `INSERT INTO ledger_vault_balances
        (tenant_id,legal_entity_id,branch_id,currency,available_amount,avg_cost)
       VALUES ($1,$2,$3,'USD',4000,'1.380000000000')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
    );
    // the drawer starts with no USD at all, so what lands in it is only what came
    await pool.query(
      "UPDATE ledger_till_balances SET available_amount=0, avg_cost=NULL WHERE till_id=$1 AND currency='USD'",
      [TILL],
    );

    const before = await bookValue(vaultId);
    expect(before.toFixed(2)).toBe("5520.00");   // 2,680 + 2,840

    const moved = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "fifo-float-1",
        counterpartyType: "vault",
        counterpartyRef: `${DEMO.branchId}:vault`,
        reason: "float",
        direction: "in",
        currency: "USD",
        amount: "1000.00",
      },
    });
    expect(moved.statusCode).toBe(201);

    /* The dollars that left the safe were Monday's, at 1.34, so that is what
       arrived in the drawer. At the safe's 1.38 average the drawer would
       have received 1,380 of book value for 1,340 of cash — 40 CAD created
       by carrying money down a corridor. */
    const arrived = await lotsAt(TILL);
    expect(arrived).toHaveLength(1);
    expect(new Decimal(arrived[0].unit_cost_home).toFixed(2)).toBe("1.34");
    expect(arrived[0].remaining_quantity).toBe("1000.00");

    // nothing was sold, so nothing was earned
    const realized = await pool.query(
      "SELECT realized_pnl_home FROM ledger_cost_events WHERE realized_pnl_home IS NOT NULL AND realized_pnl_home <> '0.00'",
    );
    expect(realized.rowCount).toBe(0);

    // and the desk is worth exactly what it was worth a minute ago
    const after = (await bookValue(vaultId)).add(await bookValue(TILL));
    expect(after.toFixed(2)).toBe(before.toFixed(2));
  });
});
