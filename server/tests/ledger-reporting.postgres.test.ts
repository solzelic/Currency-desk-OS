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
import { civilDate, civilTodayInZone } from "../src/civil-date.js";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { isoMinorUnits } from "../src/ledger/currencies.js";
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
    "TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE",
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

const DAY1_FROM = "2026-10-01T00:00:00.000Z";
const DAY1_TO = "2026-10-02T00:00:00.000Z";
const DAY1_AT = "2026-10-01T15:00:00.000Z";
const DAY2_TO = "2027-01-01T00:00:00.000Z";
const daySummary = (from: string, to: string) =>
  summary(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
const opposite = (figure: string) => (figure.startsWith("-") ? figure.slice(1) : `-${figure}`);

async function cashBusinessCheque(idempotencyKey: string, chequeNumber: string) {
  await tillHolds("CAD", 50000);
  const cashed = await app.inject({
    method: "POST", url: "/api/ledger/cheques", cookies: await cookie(),
    payload: {
      idempotencyKey, customerId: "customer-demo", chequeNumber,
      maker: "Northbridge Imports Ltd.", draweeBank: "RBC Royal Bank",
      chequeType: "business", typeLabel: "Business", currency: "CAD",
      faceAmount: "1000.00", feeAmount: "35.00", holdDays: 3, endorsed: true,
    },
  });
  expect(cashed.statusCode, cashed.body).toBe(201);
  return cashed.json() as { transactionId: string; cheque: { chequeId: string } };
}

async function backdateDeal(transactionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("UPDATE ledger_transactions SET posted_at=$2 WHERE transaction_id=$1", [transactionId, DAY1_AT]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closeAndSignOff(idempotencyKey: string) {
  const drawer = (await app.inject({
    method: "GET", url: "/api/ledger/till-balances", cookies: await cookie(),
  })).json() as { balanceGeneration: string; balances: Record<string, string> };
  const counts = Object.fromEntries(
    Object.entries(drawer.balances).map(([currency, amount]) => [currency, Number(amount).toFixed(2)]),
  );
  const closed = await app.inject({
    method: "POST", url: "/api/ledger/till-sessions/report-session-1/close", cookies: await cookie(),
    payload: { idempotencyKey, counts, note: "Signed off.", balanceGeneration: drawer.balanceGeneration },
  });
  expect(closed.statusCode, closed.body).toBe(200);
}

async function openNextSession() {
  const opened = await app.inject({
    method: "POST", url: "/api/ledger/till-sessions/open", cookies: await cookie(),
  });
  expect(opened.statusCode, opened.body).toBe(201);
}

async function branchBusinessDay(at: Date) {
  const zone = String((await pool.query(
    "SELECT COALESCE(NULLIF(trim(timezone), ''), 'America/Toronto') AS timezone FROM branches WHERE id=$1",
    [DEMO.branchId],
  )).rows[0].timezone);
  return civilTodayInZone(at, zone);
}

async function openSessionDay() {
  const day = civilDate((await pool.query(
    "SELECT business_date FROM ledger_till_sessions WHERE status='open' ORDER BY opened_at DESC LIMIT 1",
  )).rows[0].business_date);
  if (!day) throw new Error("The open session has no business date.");
  return day;
}

async function day2Cheque(key: string, number: string) {
  const cashed = await cashBusinessCheque(key, number);
  await backdateDeal(cashed.transactionId);
  await closeAndSignOff(`${key}-close`);
  const signed = await signedOffBook(cashed.transactionId);
  await openNextSession();
  return { cashed, signed, openDay: await openSessionDay(), day1: await branchBusinessDay(new Date(DAY1_AT)) };
}

async function signedOffBook(transactionId: string) {
  const book = await daySummary(DAY1_FROM, DAY1_TO);
  const counts = (await pool.query(
    `SELECT c.currency, c.expected_amount::text AS expected_amount, c.counted_amount::text AS counted_amount,
            c.variance_amount::text AS variance_amount
       FROM ledger_till_counts c
       JOIN ledger_till_count_batches b ON b.batch_id = c.batch_id
      WHERE b.session_id = 'report-session-1' AND b.count_kind = 'close'
      ORDER BY c.currency`,
  )).rows;
  const journals = (await pool.query(
    `SELECT account_code, side, amount_cad::text AS amount_cad, amount_home::text AS amount_home
       FROM ledger_journal_entries WHERE transaction_id = $1 ORDER BY account_code, side`,
    [transactionId],
  )).rows;
  return { book, counts, journals };
}

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
    expect(empty.movement).toEqual([]);
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

  it("keeps a signed-off day when its cheque is reversed the next day", async () => {
    const { cashed, signed: before } = await day2Cheque("rev-day-cash", "004821");
    expect(before.book.posted).toBe(1);
    expect(before.counts.length).toBeGreaterThan(0);
    expect(before.journals.length).toBeGreaterThan(0);
    const reversal = await app.inject({
      method: "POST",
      url: `/api/ledger/cheques/${cashed.cheque.chequeId}/reversal`,
      cookies: await cookie(),
      payload: { idempotencyKey: "rev-day-undo", reason: "Wrong cheque" },
    });
    expect(reversal.statusCode, reversal.body).toBe(201);
    const after = await signedOffBook(cashed.transactionId);
    expect.soft(after.book).toEqual(before.book);
    expect.soft(after.counts).toEqual(before.counts);
    expect.soft(after.journals).toEqual(before.journals);

    const day2 = await daySummary(DAY1_TO, DAY2_TO);
    const paidBack = before.book.movement[0].paidOut as string;
    expect.soft(day2).toMatchObject({
      posted: 0, reversed: 1,
      volumeHome: opposite(before.book.volumeHome),
      feesHome: opposite(before.book.feesHome),
      movement: [{ currency: "CAD", received: paidBack, paidOut: "0.00", net: paidBack }],
      byActor: [expect.objectContaining({
        actorId: `${DEMO.tenantId}:r.haddad`, deals: 0,
        volumeHome: opposite(before.book.volumeHome),
        feesHome: opposite(before.book.feesHome),
      })],
    });
  });

  it("nets a same-day cheque reversal out of that day's money", async () => {
    const cashed = await cashBusinessCheque("rev-same-cash", "004822");
    const from = new Date(Date.now() - 60_000).toISOString();
    const reversal = await app.inject({
      method: "POST",
      url: `/api/ledger/cheques/${cashed.cheque.chequeId}/reversal`,
      cookies: await cookie(),
      payload: { idempotencyKey: "rev-same-undo", reason: "Wrong cheque" },
    });
    expect(reversal.statusCode, reversal.body).toBe(201);
    const day = await daySummary(from, DAY2_TO);
    expect(day).toMatchObject({
      posted: 0, reversed: 1, volumeHome: null, feesHome: null,
      realizedPnlHome: null, movement: [], byCurrency: [],
    });
  });

  it("leaves a signed-off day unchanged when its cheque is returned the next day", async () => {
    const { cashed, signed: before } = await day2Cheque("ret-day-cash", "004823");
    const returned = await app.inject({
      method: "POST",
      url: `/api/ledger/cheques/${cashed.cheque.chequeId}/return`,
      cookies: await cookie(),
      payload: { idempotencyKey: "ret-day", reason: "NSF", nsf: true },
    });
    expect(returned.statusCode, returned.body).toBe(201);
    const after = await signedOffBook(cashed.transactionId);
    expect(after.book).toEqual(before.book);
    expect(after.counts).toEqual(before.counts);
    expect(after.journals).toEqual(before.journals);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_reversals")).rows[0].n,
    ).toBe(0);
    expect(await daySummary(DAY1_TO, DAY2_TO)).toMatchObject({
      posted: 0, reversed: 0, volumeHome: null, movement: [],
    });
  });

  it("dates a day-2 cheque reversal on that business day and links the original deal", async () => {
    const { cashed, openDay, day1 } = await day2Cheque("rev-row-cash", "004824");
    const reversal = await app.inject({
      method: "POST", url: `/api/ledger/cheques/${cashed.cheque.chequeId}/reversal`,
      cookies: await cookie(),
      payload: { idempotencyKey: "rev-row", reason: "Wrong cheque" },
    });
    expect(reversal.statusCode, reversal.body).toBe(201);
    const row = (await pool.query(
      "SELECT transaction_id, posted_at FROM ledger_reversals WHERE reversal_id=$1",
      [reversal.json().reversalId],
    )).rows[0];
    const businessDay = await branchBusinessDay(new Date(row.posted_at));
    expect.soft(businessDay).toBe(openDay);
    expect.soft(businessDay).not.toBe(day1);
    expect.soft(row.transaction_id).toBe(cashed.transactionId);
  });

  it("dates a day-2 cheque return on that business day and links the original deal", async () => {
    const { cashed, openDay, day1 } = await day2Cheque("ret-row-cash", "004825");
    const returned = await app.inject({
      method: "POST", url: `/api/ledger/cheques/${cashed.cheque.chequeId}/return`,
      cookies: await cookie(),
      payload: { idempotencyKey: "ret-row", reason: "NSF", nsf: true },
    });
    expect(returned.statusCode, returned.body).toBe(201);
    const row = (await pool.query(
      `SELECT t.posted_at, c.cashing_transaction_id
         FROM ledger_transactions t
         JOIN ledger_cheques c ON c.settlement_transaction_id = t.transaction_id
        WHERE c.cheque_id=$1 AND t.deal_kind='cheque_return'`,
      [cashed.cheque.chequeId],
    )).rows[0];
    const businessDay = await branchBusinessDay(new Date(row.posted_at));
    expect.soft(businessDay).toBe(openDay);
    expect.soft(businessDay).not.toBe(day1);
    expect.soft(row.cashing_transaction_id).toBe(cashed.transactionId);
  });

  it("keeps the original day's exchange when it is reversed the next day", async () => {
    await tillHolds("CAD", 50000);
    await tillHolds("USD", 4000, "1.340000000000");
    const transactionId = await sellAThousandDollars("rev-fx-cash");
    await backdateDeal(transactionId);
    const before = await daySummary(DAY1_FROM, DAY1_TO);
    const reversal = await app.inject({
      method: "POST", url: `/api/ledger/transactions/${transactionId}/reversal`,
      cookies: await cookie(),
      payload: { idempotencyKey: "rev-fx-undo", reason: "Wrong customer" },
    });
    expect(reversal.statusCode, reversal.body).toBe(201);
    expect.soft(await daySummary(DAY1_FROM, DAY1_TO)).toEqual(before);
    const day2 = await daySummary(DAY1_TO, DAY2_TO);
    const cad = before.movement.find((row: { currency: string }) => row.currency === "CAD");
    const usd = before.movement.find((row: { currency: string }) => row.currency === "USD");
    expect(day2).toMatchObject({
      posted: 0, reversed: 1,
      volumeHome: opposite(before.volumeHome), feesHome: opposite(before.feesHome),
      realizedPnlHome: opposite(before.realizedPnlHome),
      costOfSaleHome: opposite(before.costOfSaleHome),
      movement: [
        { currency: "CAD", received: "0.00", paidOut: cad.received, net: opposite(cad.received) },
        { currency: "USD", received: usd.paidOut, paidOut: "0.00", net: usd.paidOut },
      ],
    });
  });

  it("shows a stored yen amount on a closed day, and rounds each open-day row before adding", async () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString();
    const insert = (id: string, amount: string, at: string, inbound = false) =>
      pool.query(
        `INSERT INTO ledger_transactions
           (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
            workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
            input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
            source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
            jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, 'customer-demo', $3||':r.haddad',
            ${inbound ? "'JPY', 'CAD', $8, 100.00" : "'CAD', 'JPY', 100.00, $8"}, 1, 0, 0, 'travel', 'salary', $9,
            'exchange', 'cash', 'cash', 'pack-ca-v1', 1, 'CAD')`,
        [id, `ref-${id}`, ...scope, amount, at],
      );
    await insert("jpy-old", "200.80", past);
    const closed = await summary(
      `?from=${encodeURIComponent(new Date(Date.now() - 4 * 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() - 2 * 86400000).toISOString())}`,
    );
    expect(closed.byCurrency).toEqual([
      expect.objectContaining({ currency: "JPY", deals: 1, sold: "200.80" }),
    ]);

    await insert("jpy-a", "100.40", new Date().toISOString()); await insert("jpy-b", "100.40", new Date().toISOString());
    await insert("jpy-in-a", "100.40", new Date().toISOString(), true); await insert("jpy-in-b", "100.40", new Date().toISOString(), true);
    const open = await summary(
      `?from=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60 * 60 * 1000).toISOString())}`,
    );
    const today = open.byCurrency.find((row: { currency: string }) => row.currency === "JPY");
    expect(today).toMatchObject({ deals: 2, sold: "200.00" });
    const paid = open.movement.find((row: { currency: string }) => row.currency === "JPY");
    expect(paid).toMatchObject({ received: "200.00", paidOut: "200.00", net: "0.00" });
    const stored = closed.movement.find((row: { currency: string }) => row.currency === "JPY");
    expect(stored).toMatchObject({ paidOut: "200.80", net: "-200.80" });
  });

  /* A cashed cheque hands the desk a piece of paper and pays cash out.
     The face is the input amount. Counting it as cash received makes the
     drawer look like it took in money it never held. The cash that left
     is the net paid to the customer. A cash exchange in the same window
     still counts, so the cheque is left out rather than the whole total. */
  it("counts cash paid out on a cheque, and does not count the face as cash in", async () => {
    const at = new Date().toISOString();
    const book = (id: string, from: string, to: string, input: string, output: string, kind: string, received: string, disbursed: string) =>
      pool.query(
        `INSERT INTO ledger_transactions
           (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
            workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
            input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
            source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
            jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, 'customer-demo', $3||':r.haddad',
            $8, $9, $10, $11, 1, 0, 0, 'travel', 'salary', $12,
            $13, $14, $15, 'pack-ca-v1', 1, 'CAD')`,
        [id, `ref-${id}`, ...scope, from, to, input, output, at, kind, received, disbursed],
      );
    await book("chq-face", "CAD", "CAD", "1000.00", "965.00", "cheque_cashing", "cheque", "cash");
    await book("fx-cash", "CAD", "USD", "100.00", "70.00", "exchange", "cash", "cash");
    const bookSummary = await summary(
      `?from=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60 * 60 * 1000).toISOString())}`,
    );
    const cad = bookSummary.movement.find((row: { currency: string }) => row.currency === "CAD");
    const usd = bookSummary.movement.find((row: { currency: string }) => row.currency === "USD");
    expect(cad).toMatchObject({ received: "100.00", paidOut: "965.00", net: "-865.00" });
    expect(usd).toMatchObject({ received: "0.00", paidOut: "70.00", net: "-70.00" });
  });

  /* remittanceReceive sets the incoming leg to electronic_funds_transfer.
     12,000 of that is not cash in. Canada counts cash received, so 0.00 is not an LCTR. */
  it("posts a 12000 electronic transfer remittance with no cash in and no LCTR", async () => {
    await tillHolds("CAD", 20000);
    const posted = await app.inject({
      method: "POST", url: "/api/ledger/remittances/receive", cookies: await cookie(),
      payload: {
        idempotencyKey: "rmt-eft-12000", customerId: "customer-demo", reference: "TR-EFT-12000",
        sentCurrency: "CAD", sentAmount: "12000.00", payoutAmount: "12000.00", feeAmount: "0.00",
        corridor: "US", partner: "Wire partner", purpose: "Family support", sourceOfFunds: "Salary",
      },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toMatchObject({
      dealKind: "remittance_receive", inputAmount: "12000.00", cashDirection: "out", cashAmountHome: "12000.00",
    });
    const bookSummary = await summary(
      `?from=${encodeURIComponent(new Date(Date.now() - 60 * 60 * 1000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60 * 60 * 1000).toISOString())}`,
    );
    const cad = bookSummary.movement.find((row: { currency: string }) => row.currency === "CAD");
    expect(cad).toMatchObject({ received: "0.00", paidOut: "12000.00", net: "-12000.00" });
    const stored = (await pool.query(
      "SELECT received_instrument, input_amount, cash_in_home FROM ledger_transactions WHERE transaction_id=$1",
      [posted.json().transactionId],
    )).rows[0];
    expect(stored).toMatchObject({
      received_instrument: "electronic_funds_transfer", input_amount: "12000.00", cash_in_home: "0.00",
    });
  });

  it("shows a stored yen balance as stored", async () => {
    await tillHolds("JPY", 200.8);
    const held = await position();
    const jpy = held.currencies.find((row: { currency: string }) => row.currency === "JPY");
    expect(jpy.quantity).toBe("200.80");
    expect(jpy.till.quantity).toBe("200.80");
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

  it("sends the full exception table, where a missing code means 2 places", async () => {
    const answer = (
      await app.inject({
        method: "GET",
        url: "/api/ledger/jurisdiction",
        cookies: await cookie(),
      })
    ).json();
    const scales = answer.currencies.scales;
    expect(scales).toEqual(isoMinorUnits());
    expect(scales.JPY).toBe(0);
    expect(scales.KRW).toBe(0);
    expect(scales.KWD).toBe(3);
    expect(Object.hasOwn(scales, "INR")).toBe(false);
  });

  it("refuses all three reads to a session that is not signed in", async () => {
    for (const path of ["summary", "position", "jurisdiction"]) {
      const answer = await app.inject({ method: "GET", url: `/api/ledger/${path}` });
      expect(answer.statusCode).toBe(401);
    }
  });
});
