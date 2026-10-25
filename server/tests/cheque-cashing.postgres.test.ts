/* ============================================================
   Cashing a cheque, and the two ways it can end.

   Cheque cashing was one of five deal types that moved drawer cash and
   never reached the server. The browser built a row, pushed it into an
   array and wrote the cheque into localStorage, while the module's own
   header claimed the cashing "posts a ledger row … so cash, fees and the
   audit trail stay on the one source of truth."

   Every one of these tests fails against that code, because there is no
   route to call. What they are really holding is the ACCOUNTING, which is
   the part that could be shipped wrong and still look fine:

     — a cashing is not a sale. It opens a receivable and takes cash out
       of the drawer, and the journal has to show both.
     — the drawer has to fall by the NET, not the face and not the fee.
     — a cheque the drawer cannot fund is refused and NOTHING is written:
       no transaction, no cheque record, no half-moved balance.
     — the fee SURVIVES an NSF. The desk did the work.
     — a reversal is not an NSF. Cash comes back and the fee goes with it.
     — a foreign-currency cheque is refused by name rather than posted at
       an implied rate of one.
     — no cost event, ever. The cash paid out is the home currency and
       its cost is 1 by definition.
   ============================================================ */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { CHEQUE_FEE_SCHEDULE_KEY, DEFAULT_CHEQUE_SCHEDULE } from "../src/routes/tenantState.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;

const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

/** A desk with 5,000 in the drawer, an open till and one verified customer. */
async function reset(options: { openTill?: boolean; cad?: number } = {}) {
  const { openTill = true, cad = 5000 } = options;
  await pool.query(
    "TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  /* A 1,000 business cheque is 35.00 on this schedule (3.5%, no minimum).
     A 40.00 business cheque is 1.40. The payload fee is not the price. */
  const schedule = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE.map((row) =>
    row.id === "business" ? { ...row, feePct: 3.5, feeMin: 0 } : row));
  await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query(
    "INSERT INTO tenant_state (tenant_id, state, version) VALUES ($1, $2::jsonb, 1)",
    [DEMO.tenantId, JSON.stringify({ [CHEQUE_FEE_SCHEDULE_KEY]: schedule })],
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
     VALUES ($1||':a.singh',$1,$2,$3,$4,$5,'branch_manager',$6)`,
    [...scope, JSON.stringify([DEMO.branchId])],
  );
  await handle.db
    .update(schema.staffUsers)
    .set({ role: "branch_manager", authorizedBranchIds: [DEMO.branchId] })
    .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
  /* Verified, because the identification gate is a real gate on this path
     too — cashing a cheque for somebody the desk cannot name is exactly
     what it exists for. `customer-walkin` is here for the one test that
     needs the other answer. */
  await pool.query(
    `INSERT INTO ledger_customers VALUES
       ('customer-demo',$1,$2,$3,$4,'Jakob Miller','Normal','verified'),
       ('customer-walkin',$1,$2,$3,$4,'Walk-in','Normal','missing')`,
    scope.slice(0, 4),
  );
  await pool.query(
    "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',$6)",
    [...scope, cad],
  );
  if (openTill)
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ('chq-session-1',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$1||':a.singh',now())`,
      scope,
    );
}

/* ---- the calls under test, each of which ASSERTS its own success where
   it is being used as setup. A fixture that fires a request and ignores
   the answer hid a 500 in this codebase for months. ---- */

const cashCheque = (
  cookies: Record<string, string>,
  body: Record<string, unknown> = {},
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/cheques",
    payload: {
      idempotencyKey: `chq-${Math.random().toString(36).slice(2)}`,
      customerId: "customer-demo",
      chequeNumber: "004821",
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      chequeType: "business",
      typeLabel: "Business",
      currency: "CAD",
      faceAmount: "1000.00",
      feeAmount: "35.00",
      holdDays: 3,
      endorsed: true,
      ...body,
    },
    cookies,
  });

/** Cash one and hand back its id — asserted, so a setup failure says so. */
async function heldCheque(cookies: Record<string, string>, body = {}) {
  const cashed = await cashCheque(cookies, body);
  expect(
    cashed.statusCode,
    `the cheque could not be cashed: ${cashed.body}`,
  ).toBe(201);
  return cashed.json();
}

const settle = (
  cookies: Record<string, string>,
  chequeId: string,
  leg: "clearance" | "return" | "reversal",
  body: Record<string, unknown> = {},
  headers?: Record<string, string>,
) =>
  app.inject({
    method: "POST",
    url: `/api/ledger/cheques/${chequeId}/${leg}`,
    payload: {
      idempotencyKey: `${leg}-${Math.random().toString(36).slice(2)}`,
      ...body,
    },
    cookies,
    ...(headers ? { headers } : {}),
  });

/* The deal reversal route. It must refuse a cheque row. On main it
   posts the reversal, which is the failure these tests exist to catch. */
const dealReversal = (
  cookies: Record<string, string>,
  transactionId: string,
  key: string,
) =>
  app.inject({
    method: "POST",
    url: `/api/ledger/transactions/${transactionId}/reversal`,
    cookies,
    payload: { idempotencyKey: key, reason: "Wrong cheque" },
  });

async function expectDealReversalRefused(
  cookies: Record<string, string>,
  transactionId: string,
  key: string,
) {
  const generic = await dealReversal(cookies, transactionId, key);
  expect(generic.statusCode, generic.body).toBe(422);
  expect(generic.json()).toEqual({
    code: "REVERSAL_NOT_ALLOWED",
    message:
      "Reverse this cheque through POST /api/ledger/cheques/:chequeId/reversal.",
  });
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM ledger_reversals")).rows[0].n,
  ).toBe(0);
  expect(
    (await pool.query("SELECT count(*)::int AS n FROM ledger_reversal_entries")).rows[0].n,
  ).toBe(0);
}

const chequeStatus = async (chequeId: string) =>
  (
    await pool.query("SELECT status FROM ledger_cheques WHERE cheque_id=$1", [chequeId])
  ).rows[0].status as string;

const chequeEventStatuses = async (chequeId: string) =>
  (
    await pool.query(
      "SELECT status FROM ledger_cheque_events WHERE cheque_id=$1 ORDER BY created_at, event_id",
      [chequeId],
    )
  ).rows.map((row) => String(row.status));

const dealKindOf = async (transactionId: string) =>
  (
    await pool.query("SELECT deal_kind FROM ledger_transactions WHERE transaction_id=$1", [
      transactionId,
    ])
  ).rows[0].deal_kind as string;

const tillCad = async (tillId = TILL) =>
  (
    await pool.query(
      "SELECT available_amount FROM ledger_till_balances WHERE till_id=$1 AND currency='CAD'",
      [tillId],
    )
  ).rows[0]?.available_amount ?? null;

const rowCount = async (table: string) =>
  (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;

/** Every journal line on one transaction, as {account: signed amount}. */
async function journalOf(transactionId: string) {
  const rows = await pool.query(
    "SELECT account_code,side,amount_cad FROM ledger_journal_entries WHERE transaction_id=$1 ORDER BY entry_id",
    [transactionId],
  );
  return rows.rows.map((row) => ({
    account: String(row.account_code),
    side: String(row.side),
    amount: String(row.amount_cad),
  }));
}

/** Debits minus credits. Zero, or the journal is not a journal. */
const imbalance = (lines: { side: string; amount: string }[]) =>
  lines.reduce(
    (total, line) =>
      total + (line.side === "debit" ? Number(line.amount) : -Number(line.amount)),
    0,
  );

const reversalEntriesOf = async (reversalId: string) =>
  (
    await pool.query(
      "SELECT account_code,side,amount_cad FROM ledger_reversal_entries WHERE reversal_id=$1",
      [reversalId],
    )
  ).rows.map((row) => ({
    account: String(row.account_code),
    side: String(row.side),
    amount: String(row.amount_cad),
  }));

postgres("cheque cashing on the ledger", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    /* Hand the database back empty — the suites share one, and a cheque
       left behind would count toward another file's totals. The second
       till's balance insert bumps ledger_till_balance_generations, and
       that row is not in the truncate list, so remove it here. */
    await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques CASCADE");
    await pool.query(
      "DELETE FROM ledger_till_balance_generations WHERE workspace_id=$1 AND till_id=$2",
      ["ws-yorkville-till-02", "till-02"],
    );
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  /* ------------------------------------------------------------------
     1. THE CASHING
     ------------------------------------------------------------------ */

  it("opens a receivable, takes the net out of the drawer, and keeps the fee", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);

    /* Face 1,000, fee 35, net 965 — the worked example in
       docs/CHEQUE_CASHING.md. */
    expect(cashed.cheque.faceAmount).toBe("1000.00");
    expect(cashed.cheque.feeAmount).toBe("35.00");
    expect(cashed.cheque.netAmount).toBe("965.00");
    expect(cashed.cheque.status).toBe("held");

    const journal = await journalOf(cashed.transactionId);
    expect(imbalance(journal)).toBe(0);
    expect(journal).toEqual([
      { account: "asset:cheques_held", side: "debit", amount: "1000.00" },
      { account: "till:CAD", side: "credit", amount: "965.00" },
      { account: "revenue:cheque_fee", side: "credit", amount: "35.00" },
    ]);

    // the drawer falls by the NET. Not the face — the fee never left.
    expect(await tillCad()).toBe("4035.00");
    expect(cashed.balances.CAD).toBe("4035.00");

    /* The movement is recorded as one, in the same direction the money
       actually went. A cashing that recorded an "in" would balance the
       drawer and lie about it. */
    const movements = await pool.query(
      "SELECT currency,direction,amount FROM ledger_till_movements WHERE transaction_id=$1",
      [cashed.transactionId],
    );
    expect(movements.rows).toEqual([
      { currency: "CAD", direction: "out", amount: "965.00" },
    ]);
  });

  it("records what actually crossed the counter, not what the amounts imply", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const row = (
      await pool.query(
        "SELECT deal_kind,received_instrument,disbursed_instrument,from_currency,to_currency,input_amount,realized_pnl_home,cost_of_sale_home FROM ledger_transactions WHERE transaction_id=$1",
        [cashed.transactionId],
      )
    ).rows[0];

    /* Every amount column on this row says Canadian dollars in and
       Canadian dollars out. A compliance engine reading only those would
       conclude the desk RECEIVED a thousand dollars in cash, which is
       wrong in both halves — it received a piece of paper and it PAID
       cash. These three columns are what stop it having to guess. */
    expect(row.deal_kind).toBe("cheque_cashing");
    expect(row.received_instrument).toBe("cheque");
    expect(row.disbursed_instrument).toBe("cash");
    expect(row.from_currency.trim()).toBe("CAD");
    expect(row.input_amount).toBe("1000.00");

    /* AND NO COST EVENT. The cash paid out is the home currency, whose
       cost is 1 by definition — there is no average to move and no margin
       to realize. See docs/COST_BASIS.md, "The home currency". */
    expect(row.realized_pnl_home).toBeNull();
    expect(row.cost_of_sale_home).toBeNull();
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_cost_events")).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query("SELECT avg_cost FROM ledger_till_balances WHERE currency='CAD'"))
        .rows[0].avg_cost,
    ).toBeNull();
  });

  it("dates the cheque and its hold from the till's business day", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies, { holdDays: 5 });
    /* The session's business date is 2026-06-18. The browser used to
       compute both of these — and the reference number — from its own
       idea of today and its own local list. */
    expect(cashed.cheque.receivedDate).toBe("2026-06-18");
    expect(cashed.cheque.holdUntil).toBe("2026-06-23");
    expect(cashed.cheque.ref).toBe("CHQ-260618-001");

    const second = await heldCheque(cookies, { chequeNumber: "004822" });
    expect(second.cheque.ref).toBe("CHQ-260618-002");
  });

  /* ------------------------------------------------------------------
     2. THE DRAWER HAS TO HAVE IT
     ------------------------------------------------------------------ */

  it("refuses a cheque the drawer cannot fund, and writes nothing at all", async () => {
    await reset({ cad: 500 });
    const cookies = await cookie();

    const refused = await cashCheque(cookies);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("INSUFFICIENT_TILL_LIQUIDITY");

    /* The whole transaction rolled back, so there is no half-cashed
       cheque: no ledger row, no receivable, no cheque record, and the
       drawer is exactly where it was. A cheque record surviving a refused
       cashing would put the desk's "cash at risk" figure above the cash
       it has ever had. */
    expect(await tillCad()).toBe("500.00");
    for (const table of [
      "ledger_transactions",
      "ledger_journal_entries",
      "ledger_till_movements",
      "ledger_cheques",
      "ledger_cheque_events",
    ]) {
      const count = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(count.rows[0].n, `${table} should be empty`).toBe(0);
    }
  });

  it("refuses when the till is not open", async () => {
    await reset({ openTill: false });
    const cookies = await cookie();
    const refused = await cashCheque(cookies);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("TILL_NOT_OPEN");
    expect(await tillCad()).toBe("5000.00");
  });

  it("cashes a home-currency cheque on a dinar desk and still refuses a foreign one", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET home_currency = 'RSD', jurisdiction_pack_id = 'pack-intl-v1', jurisdiction_pack_version = 1
        WHERE id = $1`,
      [DEMO.legalEntityId],
    );
    await pool.query(
      "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'RSD',5000)",
      scope,
    );
    const cookies = await cookie();
    const cashed = await heldCheque(cookies, { currency: "RSD" });
    expect(cashed.cheque.currency).toBe("RSD");
    expect(cashed.cheque.netAmount).toBe("965.00");
    const journal = await journalOf(cashed.transactionId);
    expect(imbalance(journal)).toBe(0);
    expect(journal).toEqual([
      { account: "asset:cheques_held", side: "debit", amount: "1000.00" },
      { account: "till:RSD", side: "credit", amount: "965.00" },
      { account: "revenue:cheque_fee", side: "credit", amount: "35.00" },
    ]);
    const dinar = await pool.query(
      "SELECT available_amount FROM ledger_till_balances WHERE till_id=$1 AND currency='RSD'",
      [TILL],
    );
    expect(dinar.rows[0].available_amount).toBe("4035.00");

    const foreign = await cashCheque(cookies, { currency: "CAD" });
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json().code).toBe("CHEQUE_CURRENCY_NOT_HOME");
    expect(foreign.json().message).toMatch(/RSD/);

    /* Canada is the same rule, not a special case. Put the desk back and
       a US-dollar cheque is still refused, by name, in Canadian dollars. */
    await pool.query(
      `UPDATE legal_entities
          SET home_currency = 'CAD', jurisdiction_pack_id = 'pack-ca-v1', jurisdiction_pack_version = 1
        WHERE id = $1`,
      [DEMO.legalEntityId],
    );
    const canada = await cashCheque(cookies, { currency: "USD" });
    expect(canada.statusCode).toBe(422);
    expect(canada.json().code).toBe("CHEQUE_CURRENCY_NOT_HOME");
    expect(canada.json().message).toMatch(/CAD/);
    expect(await tillCad()).toBe("5000.00");
  });

  it("refuses a cheque that is not in the desk's own currency, and says why", async () => {
    const cookies = await cookie();
    const refused = await cashCheque(cookies, { currency: "USD" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("CHEQUE_CURRENCY_NOT_HOME");
    /* Named rather than blanket. A US dollar cheque cashed for Canadian
       dollars is an exchange AND a cashing, and posting it here would put
       it through at an implied rate of one — a thousand Canadian dollars
       for a thousand-dollar American cheque. The message has to send the
       teller to the right place, so it says so. */
    expect(refused.json().message).toMatch(/CAD/);
    expect(refused.json().message).toMatch(/exchange/i);
    expect(await tillCad()).toBe("5000.00");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_cheques")).rows[0].n,
    ).toBe(0);
  });

  it("applies the desk's identification line to a cheque like any other deal", async () => {
    const cookies = await cookie();
    /* Canada's pack identifies at 3,000, and this customer has no ID on
       file. Handing 3,900 dollars over the counter to somebody the desk
       cannot name is exactly the deal the gate exists for; the paper the
       money came in against does not change that. */
    const refused = await cashCheque(cookies, {
      customerId: "customer-walkin",
      faceAmount: "4000.00",
      feeAmount: "100.00",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(await tillCad()).toBe("5000.00");

    // and a small one from the same unidentified customer still goes through
    const small = await cashCheque(cookies, {
      customerId: "customer-walkin",
      faceAmount: "200.00",
      feeAmount: "10.00",
    });
    expect(small.statusCode).toBe(201);
  });

  /* ------------------------------------------------------------------
     3. CLEARING
     ------------------------------------------------------------------ */

  it("moves the receivable to the bank when it clears, and leaves the drawer alone", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const before = await tillCad();

    const cleared = await settle(cookies, cashed.cheque.chequeId, "clearance");
    expect(cleared.statusCode).toBe(201);
    expect(cleared.json().status).toBe("cleared");

    const journal = await journalOf(cleared.json().transactionId);
    expect(imbalance(journal)).toBe(0);
    expect(journal).toEqual([
      { account: "asset:bank_clearing", side: "debit", amount: "1000.00" },
      { account: "asset:cheques_held", side: "credit", amount: "1000.00" },
    ]);

    /* NO TILL MOVEMENT. The funds arrive at the bank, not in the drawer —
       the cash the desk fronted left days ago. A clearance that credited
       the till would put the same money in the drawer twice. */
    expect(await tillCad()).toBe(before);
    const movements = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_till_movements WHERE transaction_id=$1",
      [cleared.json().transactionId],
    );
    expect(movements.rows[0].n).toBe(0);
  });

  it("will not clear the same cheque twice", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    expect((await settle(cookies, cashed.cheque.chequeId, "clearance")).statusCode).toBe(201);

    const again = await settle(cookies, cashed.cheque.chequeId, "clearance");
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("CHEQUE_NOT_HELD");
    /* Two clearances would credit the receivable twice and leave
       `asset:cheques_held` a thousand dollars short of the cheques the
       desk is actually carrying. */
    const held = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_journal_entries WHERE account_code='asset:cheques_held'",
    );
    expect(held.rows[0].n).toBe(2); // the cashing's debit and one credit
  });

  /* ------------------------------------------------------------------
     4. THE RETURN — and the fee that survives it
     ------------------------------------------------------------------ */

  it("books the face amount as a loss when a cheque comes back, and KEEPS the fee", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const before = await tillCad();

    const bounced = await settle(cookies, cashed.cheque.chequeId, "return", {
      reason: "NSF — insufficient funds",
      nsf: true,
    });
    expect(bounced.statusCode).toBe(201);

    const journal = await journalOf(bounced.json().transactionId);
    expect(imbalance(journal)).toBe(0);
    expect(journal).toEqual([
      { account: "expense:cheque_losses", side: "debit", amount: "1000.00" },
      { account: "asset:cheques_held", side: "credit", amount: "1000.00" },
    ]);

    /* THE FEE SURVIVES. The desk examined the paper, took the risk,
       handed over the cash and now has to chase it — that is the work the
       fee paid for, and keeping it is ordinary practice. Nothing anywhere
       in this event touches `revenue:cheque_fee`, and this assertion is
       what stops a future "tidy-up" reversing it. */
    const feeLines = await pool.query(
      "SELECT side,amount_cad FROM ledger_journal_entries WHERE account_code='revenue:cheque_fee'",
    );
    expect(feeLines.rows).toEqual([{ side: "credit", amount_cad: "35.00" }]);

    // and the drawer does not move: that cash is gone, not returning
    expect(await tillCad()).toBe(before);

    const record = (
      await pool.query("SELECT status,nsf,fraud,returned_reason FROM ledger_cheques WHERE cheque_id=$1", [
        cashed.cheque.chequeId,
      ])
    ).rows[0];
    expect(record.status).toBe("returned");
    expect(record.nsf).toBe(true);
    expect(record.fraud).toBe(false);
    expect(record.returned_reason).toBe("NSF — insufficient funds");
  });

  it("refuses a return with no reason — a loss the desk cannot explain is not a record", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const nameless = await settle(cookies, cashed.cheque.chequeId, "return", { reason: "" });
    expect(nameless.statusCode).toBe(400);
    expect(
      (await pool.query("SELECT status FROM ledger_cheques WHERE cheque_id=$1", [
        cashed.cheque.chequeId,
      ])).rows[0].status,
    ).toBe("held");
  });

  /* ------------------------------------------------------------------
     5. THE REVERSAL — which is NOT a return
     ------------------------------------------------------------------ */

  it("puts the cash back and reverses the fee when the cashing was a mistake", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    expect(await tillCad()).toBe("4035.00");

    const undone = await settle(cookies, cashed.cheque.chequeId, "reversal", {
      reason: "Keyed against the wrong customer",
    });
    expect(undone.statusCode).toBe(201);
    expect(undone.json().status).toBe("reversed");

    // the drawer is exactly where it started — the cash never should have left
    expect(await tillCad()).toBe("5000.00");
    expect(undone.json().balances.CAD).toBe("5000.00");

    /* THE DIFFERENCE FROM AN NSF, stated as an assertion. Every line of
       the cashing is mirrored, INCLUDING the fee: `revenue:cheque_fee` is
       DEBITED here, because the desk did not perform a service it is
       entitled to charge for. On a return that line is untouched. */
    const mirrored = await reversalEntriesOf(undone.json().reversalId);
    expect(mirrored).toEqual(
      expect.arrayContaining([
        { account: "asset:cheques_held", side: "credit", amount: "1000.00" },
        { account: "till:CAD", side: "debit", amount: "965.00" },
        { account: "revenue:cheque_fee", side: "debit", amount: "35.00" },
      ]),
    );
    expect(mirrored).toHaveLength(3);

    // no expense is booked: nothing was lost, the deal did not happen
    const losses = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_journal_entries WHERE account_code='expense:cheque_losses'",
    );
    expect(losses.rows[0].n).toBe(0);
  });

  /* The cash left till-01. A reversal signed in at till-02 must not
     drop that cash into till-02. On main it does, and this test fails. */
  it("puts a reversal back only in the till that paid the cheque, and writes nothing from another till", async () => {
    const secondWorkspace = "ws-yorkville-till-02";
    const secondTill = "till-02";
    await handle.db.insert(schema.workspaces).values({
      id: secondWorkspace,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      tillId: secondTill,
    }).onConflictDoNothing();
    await pool.query(
      `INSERT INTO ledger_till_balances
        (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5,'CAD','8000.00')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, secondWorkspace, secondTill],
    );
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ('chq-session-2',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$6,now())`,
      [
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        secondWorkspace,
        secondTill,
        `${DEMO.tenantId}:a.singh`,
      ],
    );
    await pool.query(
      `INSERT INTO ledger_principals
        (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES ($1,$2,$3,$4,$5,$6,'branch_manager',$7)`,
      [
        `${DEMO.tenantId}:a.singh`,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        secondWorkspace,
        secondTill,
        JSON.stringify([DEMO.branchId]),
      ],
    );

    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    expect(await tillCad()).toBe("4035.00");
    expect(await tillCad(secondTill)).toBe("8000.00");
    expect(imbalance(await journalOf(cashed.transactionId))).toBe(0);

    const before = {
      reversals: await rowCount("ledger_reversals"),
      entries: await rowCount("ledger_reversal_entries"),
      movements: await rowCount("ledger_till_movements"),
      journals: await rowCount("ledger_journal_entries"),
      events: await rowCount("ledger_cheque_events"),
      audits: await rowCount("ledger_audit_events"),
      keys: await rowCount("ledger_idempotency"),
    };

    const refused = await settle(
      cookies,
      cashed.cheque.chequeId,
      "reversal",
      { reason: "Wrong till" },
      { "x-workspace-id": secondWorkspace },
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toEqual({
      code: "CHEQUE_REVERSAL_WRONG_TILL",
      message: "Reverse this cheque at the till that paid it out. Nothing was reversed.",
    });
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("held");
    expect(
      (
        await pool.query("SELECT reversal_id FROM ledger_cheques WHERE cheque_id=$1", [
          cashed.cheque.chequeId,
        ])
      ).rows[0].reversal_id,
    ).toBeNull();
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held"]);
    expect(await tillCad()).toBe("4035.00");
    expect(await tillCad(secondTill)).toBe("8000.00");
    expect(await rowCount("ledger_reversals")).toBe(before.reversals);
    expect(await rowCount("ledger_reversal_entries")).toBe(before.entries);
    expect(await rowCount("ledger_till_movements")).toBe(before.movements);
    expect(await rowCount("ledger_journal_entries")).toBe(before.journals);
    expect(await rowCount("ledger_cheque_events")).toBe(before.events);
    expect(await rowCount("ledger_audit_events")).toBe(before.audits);
    expect(await rowCount("ledger_idempotency")).toBe(before.keys);
    expect(imbalance(await journalOf(cashed.transactionId))).toBe(0);

    const undone = await settle(
      cookies,
      cashed.cheque.chequeId,
      "reversal",
      { reason: "Keyed on the till that paid it" },
      { "x-workspace-id": DEMO.workspaceId },
    );
    expect(undone.statusCode, undone.body).toBe(201);
    expect(undone.json().status).toBe("reversed");
    expect(await tillCad()).toBe("5000.00");
    expect(undone.json().balances.CAD).toBe("5000.00");
    expect(await tillCad(secondTill)).toBe("8000.00");
    const mirrored = await reversalEntriesOf(undone.json().reversalId);
    expect(imbalance(mirrored)).toBe(0);
    expect(mirrored).toEqual(
      expect.arrayContaining([
        { account: "asset:cheques_held", side: "credit", amount: "1000.00" },
        { account: "till:CAD", side: "debit", amount: "965.00" },
        { account: "revenue:cheque_fee", side: "debit", amount: "35.00" },
      ]),
    );
    expect(mirrored).toHaveLength(3);
    expect(imbalance(await journalOf(cashed.transactionId))).toBe(0);
  });

  /* A closed session is the day close. A close count on that session is
     the signed close-out. Neither may take a reversal or a return. */
  const dayClosedRefusal =
    "This day is closed. Reversals and returns can't be posted to it.";
  const dayClosedReversalNext =
    "Open a new session on the till that paid this cheque out. A supervisor or manager then reverses it there.";
  const dayClosedReturnNext =
    "Open a new session on the till that paid this cheque out. Then post the return there.";

  function dayClosedBody(leg: "reversal" | "return") {
    return {
      code: "CHEQUE_DAY_CLOSED",
      message: dayClosedRefusal,
      next: leg === "reversal" ? dayClosedReversalNext : dayClosedReturnNext,
    };
  }

  async function bookSnapshot() {
    return {
      reversals: await rowCount("ledger_reversals"),
      entries: await rowCount("ledger_reversal_entries"),
      movements: await rowCount("ledger_till_movements"),
      journals: await rowCount("ledger_journal_entries"),
      transactions: await rowCount("ledger_transactions"),
      events: await rowCount("ledger_cheque_events"),
      audits: await rowCount("ledger_audit_events"),
      keys: await rowCount("ledger_idempotency"),
      cheques: await rowCount("ledger_cheques"),
    };
  }

  async function closePayingDay(signedOff: boolean) {
    const who = `${DEMO.tenantId}:a.singh`;
    await pool.query(
      `UPDATE ledger_till_sessions
          SET status='closed', closed_by=$1, closed_at=now()
        WHERE session_id='chq-session-1'`,
      [who],
    );
    if (!signedOff) return;
    await pool.query(
      `INSERT INTO ledger_till_count_batches
        (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
         till_id,count_kind,actor_id,idempotency_key,counted_at)
       VALUES ('chq-signoff-1','chq-session-1',$1,$2,$3,$4,$5,'close',$6,'chq-signoff-key',now())`,
      [...scope, who],
    );
  }

  async function expectDayRefused(leg: "reversal" | "return", signedOff: boolean) {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const till = await tillCad();
    await closePayingDay(signedOff);
    const before = await bookSnapshot();
    const refused = await settle(cookies, cashed.cheque.chequeId, leg, {
      reason: leg === "return" ? "NSF" : "Wrong day",
      ...(leg === "return" ? { nsf: true } : {}),
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toEqual(dayClosedBody(leg));
    expect(await tillCad()).toBe(till);
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("held");
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held"]);
    expect(await bookSnapshot()).toEqual(before);
    expect(imbalance(await journalOf(cashed.transactionId))).toBe(0);
  }

  it("refuses a reversal on a closed day and leaves the till where it was", async () => {
    await expectDayRefused("reversal", false);
  });

  it("names a supervisor or manager when a reversal is refused on a closed day", async () => {
    await expectDayRefused("reversal", false);
  });

  it("refuses a return on a closed day and leaves the cheque held", async () => {
    await expectDayRefused("return", false);
  });

  it("refuses a reversal on a signed-off day and leaves the till where it was", async () => {
    await expectDayRefused("reversal", true);
  });

  it("refuses a return on a signed-off day and leaves the cheque held", async () => {
    await expectDayRefused("return", true);
  });

  it("still reverses into the till that paid the cheque while the day is open", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    expect(await tillCad()).toBe("4035.00");
    const undone = await settle(cookies, cashed.cheque.chequeId, "reversal", {
      reason: "Open day",
    });
    expect(undone.statusCode, undone.body).toBe(201);
    expect(undone.json().status).toBe("reversed");
    expect(await tillCad()).toBe("5000.00");
    expect(undone.json().balances.CAD).toBe("5000.00");
  });

  /* Guard. A cheque cashed on a day that was later closed and signed
     off may still be reversed, or returned, once a new session is open.
     The post lands in that open session. The closed day's sealed rows
     stay as they were. */
  it("posts a past cheque into the new open session and leaves the signed-off day unchanged", async () => {
    const cookies = await cookie();
    const who = `${DEMO.tenantId}:a.singh`;
    const toReverse = await heldCheque(cookies, { chequeNumber: "004821" });
    const toReturn = await heldCheque(cookies, { chequeNumber: "004822" });
    expect(await tillCad()).toBe("3070.00");

    await pool.query(
      `UPDATE ledger_till_sessions
          SET status='closed', closed_by=$1, closed_at=now(), close_note='Signed off'
        WHERE session_id='chq-session-1'`,
      [who],
    );
    await pool.query(
      `INSERT INTO ledger_till_count_batches
        (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
         till_id,count_kind,actor_id,idempotency_key,counted_at)
       VALUES ('chq-day1-close','chq-session-1',$1,$2,$3,$4,$5,'close',$6,'chq-day1-close-key',now())`,
      [...scope, who],
    );
    await pool.query(
      `INSERT INTO ledger_till_counts
        (batch_id,currency,expected_amount,counted_amount,variance_amount,stored_expected_amount)
       VALUES ('chq-day1-close','CAD',3070.00,3070.00,0.00,3070.00)`,
    );
    await pool.query(
      `INSERT INTO ledger_till_sessions
        (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
         session_number,business_date,status,opened_by,opened_at)
       VALUES ('chq-session-2',$1,$2,$3,$4,$5,2,DATE '2026-06-19','open',$6,now())`,
      [...scope, who],
    );

    const cashingIds = [toReverse.transactionId, toReturn.transactionId];
    const sealed = async (sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows.map((row) => String(row.snapshot));
    /* Day 1's sealed close, and the journals written that day. The
       live drawer is day 2's and is allowed to move. The day's
       summary is not part of this check. */
    const dayOne = async () => ({
      closeCount: await sealed(
        `SELECT row_to_json(x)::text AS snapshot FROM (
           SELECT b.batch_id, b.session_id, b.count_kind, b.actor_id, b.idempotency_key,
                  c.count_id, c.currency, c.expected_amount, c.counted_amount,
                  c.variance_amount, c.stored_expected_amount
             FROM ledger_till_count_batches b
             JOIN ledger_till_counts c ON c.batch_id = b.batch_id
            WHERE b.session_id = 'chq-session-1'
            ORDER BY b.batch_id, c.count_id
         ) x`,
      ),
      journals: await sealed(
        `SELECT row_to_json(j)::text AS snapshot
           FROM ledger_journal_entries j
          WHERE transaction_id = ANY($1::text[])
          ORDER BY entry_id`,
        [cashingIds],
      ),
    });

    const before = await dayOne();

    const reversed = await settle(cookies, toReverse.cheque.chequeId, "reversal", {
      reason: "Next day",
    });
    expect(reversed.statusCode, reversed.body).toBe(201);
    expect(reversed.json().status).toBe("reversed");
    expect(await tillCad()).toBe("4035.00");
    expect(reversed.json().balances.CAD).toBe("4035.00");
    expect(await dayOne()).toEqual(before);

    const returned = await settle(cookies, toReturn.cheque.chequeId, "return", {
      reason: "NSF",
      nsf: true,
    });
    expect(returned.statusCode, returned.body).toBe(201);
    expect(returned.json().status).toBe("returned");
    expect(await tillCad()).toBe("4035.00");
    expect(returned.json().balances.CAD).toBe("4035.00");
    expect(await dayOne()).toEqual(before);
  });

  it("keeps a reversal and an NSF on separate paths", async () => {
    const cookies = await cookie();
    const bounced = await heldCheque(cookies, { chequeNumber: "A" });
    const mistake = await heldCheque(cookies, { chequeNumber: "B" });

    await settle(cookies, bounced.cheque.chequeId, "return", { reason: "NSF", nsf: true });
    await settle(cookies, mistake.cheque.chequeId, "reversal", { reason: "Mis-keyed" });

    const statuses = await pool.query(
      "SELECT cheque_id,status,nsf FROM ledger_cheques ORDER BY cheque_number",
    );
    expect(statuses.rows.map((r) => [r.status, r.nsf])).toEqual([
      ["returned", true],
      ["reversed", false],
    ]);

    /* Two cheques, both 1,000 face, both "didn't work out". One left the
       desk 1,000 down and keeping 35; the other left it exactly where it
       started. The drawer proves they took different paths: 5,000 minus
       one net of 965, and not two. */
    expect(await tillCad()).toBe("4035.00");

    /* And a reversed cashing drops out of the day's totals the way any
       void does, while the bounced one stays — it really happened. */
    const summary = await app.inject({
      method: "GET",
      url: "/api/ledger/summary",
      cookies,
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().posted).toBe(1);
    expect(summary.json().reversed).toBe(1);
    expect(summary.json().feesHome).toBe("35.00");
  });

  it("will not reverse a cheque that has already cleared", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    await settle(cookies, cashed.cheque.chequeId, "clearance");

    const late = await settle(cookies, cashed.cheque.chequeId, "reversal", {
      reason: "Too late",
    });
    /* The bank has already paid. Undoing the cashing now would take cash
       back into the drawer against a receivable that no longer exists,
       which is a bank reconciliation problem and not something a button
       should attempt. */
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("CHEQUE_NOT_HELD");
  });

  /* The deal reversal route knows an exchange. It does not know a
     cheque. On main it reverses the row, leaves the cheque held (or
     cleared, or returned), writes no cheque event, and a later call to
     the cheque route is refused forever with REVERSAL_ALREADY_EXISTS
     when the row was the cashing. */
  it("refuses the deal reversal route for a cheque cashing, and the cheque route still works", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    expect(await dealKindOf(cashed.transactionId)).toBe("cheque_cashing");
    await expectDealReversalRefused(cookies, cashed.transactionId, "block-cashing");
    expect(await tillCad()).toBe("4035.00");
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("held");
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held"]);

    const proper = await settle(cookies, cashed.cheque.chequeId, "reversal", {
      reason: "Wrong customer",
    });
    expect(proper.statusCode, proper.body).toBe(201);
    expect(proper.json().status).toBe("reversed");
    expect(proper.json().code).not.toBe("REVERSAL_ALREADY_EXISTS");
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("reversed");
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held", "reversed"]);
    expect(await tillCad()).toBe("5000.00");
  });

  it("refuses the deal reversal route for a cheque clearing and leaves the cheque cleared", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const cleared = await settle(cookies, cashed.cheque.chequeId, "clearance");
    expect(cleared.statusCode, cleared.body).toBe(201);
    const settlementId = String(cleared.json().transactionId);
    expect(await dealKindOf(settlementId)).toBe("cheque_clearing");
    const till = await tillCad();
    await expectDealReversalRefused(cookies, settlementId, "block-clearing");
    expect(await tillCad()).toBe(till);
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("cleared");
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held", "cleared"]);
  });

  it("refuses the deal reversal route for a cheque return and leaves the cheque returned", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const bounced = await settle(cookies, cashed.cheque.chequeId, "return", {
      reason: "NSF",
      nsf: true,
    });
    expect(bounced.statusCode, bounced.body).toBe(201);
    const settlementId = String(bounced.json().transactionId);
    expect(await dealKindOf(settlementId)).toBe("cheque_return");
    const till = await tillCad();
    await expectDealReversalRefused(cookies, settlementId, "block-return");
    expect(await tillCad()).toBe(till);
    expect(await chequeStatus(cashed.cheque.chequeId)).toBe("returned");
    expect(await chequeEventStatuses(cashed.cheque.chequeId)).toEqual(["held", "returned"]);
  });

  /* ------------------------------------------------------------------
     6. SAYING IT TWICE
     ------------------------------------------------------------------ */

  it("cashes once however many times the request arrives", async () => {
    const cookies = await cookie();
    const body = { idempotencyKey: "chq-double-tap" };
    const first = await cashCheque(cookies, body);
    const second = await cashCheque(cookies, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().cheque.chequeId).toBe(first.json().cheque.chequeId);

    // one cheque, one transaction, one movement of the drawer
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_cheques")).rows[0].n,
    ).toBe(1);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_transactions")).rows[0].n,
    ).toBe(1);
    expect(await tillCad()).toBe("4035.00");
  });

  /* Two taps of one open form used to be two keys, because the key was
     built from the clock. Cheque 1002841 (face 40.00, payload fee 1.00)
     was then paid twice and 78.00 left the drawer, the net, twice. This
     test still sends 1.00. The schedule books 1.40. A second live cheque
     with the same number, payer and bank is the same paper, and the book
     has to refuse it even when the keys differ. */
  it("pays cheque 1002841 once when a second tap arrives under a new key", async () => {
    const cookies = await cookie();
    const paper = {
      chequeNumber: "1002841",
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      faceAmount: "40.00",
      feeAmount: "1.00",
      holdDays: 0,
    };
    const first = await cashCheque(cookies, { ...paper, idempotencyKey: "tap-1002841-a" });
    expect(first.statusCode, first.body).toBe(201);
    const second = await cashCheque(cookies, { ...paper, idempotencyKey: "tap-1002841-b" });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("CHEQUE_ALREADY_HELD");
    expect(second.json().message).toMatch(/already cashed/i);
    expect(await tillCad()).toBe("4961.40");
    expect(
      (await pool.query(
        "SELECT count(*)::int AS n FROM ledger_cheques WHERE cheque_number='1002841'",
      )).rows[0].n,
    ).toBe(1);
  });

  it("still cashes a different cheque, and the same number once it is no longer live", async () => {
    const cookies = await cookie();
    const paper = {
      chequeNumber: "1002841",
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      faceAmount: "40.00",
      feeAmount: "1.00",
      holdDays: 0,
    };
    const first = await cashCheque(cookies, { ...paper, idempotencyKey: "live-a" });
    expect(first.statusCode, first.body).toBe(201);
    const otherNumber = await cashCheque(cookies, {
      ...paper,
      chequeNumber: "1002842",
      idempotencyKey: "live-b",
    });
    expect(otherNumber.statusCode, otherNumber.body).toBe(201);
    const otherBank = await cashCheque(cookies, {
      ...paper,
      draweeBank: "TD Canada Trust",
      idempotencyKey: "live-c",
    });
    expect(otherBank.statusCode, otherBank.body).toBe(201);
    const undone = await settle(cookies, first.json().cheque.chequeId, "reversal", {
      reason: "Cashed the wrong cheque",
    });
    expect(undone.statusCode, undone.body).toBe(201);
    const again = await cashCheque(cookies, { ...paper, idempotencyKey: "live-d" });
    expect(again.statusCode, again.body).toBe(201);
    /* Four cashes of 38.60, and the first of them reversed, so three nets
       have left: 5000 - 115.80 = 4884.20. The schedule prices 40.00 at 1.40. */
    expect(await tillCad()).toBe("4884.20");
  });

  it("clears once however many times the request arrives", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    const body = { idempotencyKey: "chq-clear-twice" };
    const first = await settle(cookies, cashed.cheque.chequeId, "clearance", body);
    const second = await settle(cookies, cashed.cheque.chequeId, "clearance", body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().transactionId).toBe(first.json().transactionId);
    expect(
      (await pool.query(
        "SELECT count(*)::int AS n FROM ledger_journal_entries WHERE account_code='asset:bank_clearing'",
      )).rows[0].n,
    ).toBe(1);
  });

  /* ------------------------------------------------------------------
     7. THE REGISTER, AND WHAT A SETTLEMENT IS NOT
     ------------------------------------------------------------------ */

  it("serves the branch's register with its timeline", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    await settle(cookies, cashed.cheque.chequeId, "clearance");

    const register = await app.inject({
      method: "GET",
      url: "/api/ledger/cheques",
      cookies,
    });
    expect(register.statusCode).toBe(200);
    const [cheque] = register.json().cheques;
    expect(cheque.ref).toBe("CHQ-260618-001");
    expect(cheque.maker).toBe("Northbridge Imports Ltd.");
    expect(cheque.draweeBank).toBe("RBC Royal Bank");
    expect(cheque.status).toBe("cleared");
    expect(cheque.netAmount).toBe("965.00");
    /* Who moved it and when, which is the half of this the browser was
       keeping in localStorage and calling an audit trail. */
    expect(cheque.timeline.map((step: { status: string }) => step.status)).toEqual([
      "held",
      "cleared",
    ]);
    expect(cheque.timeline[1].actorId).toContain("a.singh");
  });

  it("does not let a settlement count as a deal", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies);
    await settle(cookies, cashed.cheque.chequeId, "clearance");

    /* A clearance carries a journal, so it is a transaction row. It is
       not a deal somebody did at the counter, and counting it as one
       would report a single 1,000-dollar cheque as two deals and 2,000
       of volume — in the totals a reporting threshold is tested against. */
    const summary = await app.inject({ method: "GET", url: "/api/ledger/summary", cookies });
    expect(summary.json().posted).toBe(1);
    expect(summary.json().volumeHome).toBe("1000.00");

    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/transactions?limit=100",
      cookies,
    });
    expect(listed.json().transactions).toHaveLength(1);
    expect(listed.json().transactions[0].dealKind).toBe("cheque_cashing");
    expect(listed.json().transactions[0].receivedInstrument).toBe("cheque");
  });

  it("keeps a cheque's timeline append-only once written", async () => {
    const cookies = await cookie();
    await heldCheque(cookies);
    await expect(
      pool.query("UPDATE ledger_cheque_events SET note='tidied up'"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM ledger_cheque_events"),
    ).rejects.toThrow(/append-only/);
  });

  /* The unique index lands on a book that may already hold two live
     copies of one cheque — that is the bug. Creating the index over
     those rows must not abort boot. The older copy stays held (the
     cash is still out) and is left out of the index. */
  it("applies the live-paper index over a book that already holds a duplicate cheque", async () => {
    const cookies = await cookie();
    const cashed = await heldCheque(cookies, {
      chequeNumber: "1002841",
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      idempotencyKey: "dup-migrate-newer",
    });
    const newerId = cashed.cheque.chequeId as string;

    /* The book as it was before this migration: no index, and two
       held rows for the same paper. */
    await pool.query("DROP INDEX IF EXISTS ledger_cheques_live_paper_idx");
    await pool.query("ALTER TABLE ledger_cheques DROP COLUMN IF EXISTS paper_guard");
    await pool.query(
      "DELETE FROM schema_migrations WHERE migration_id = '039_live_cheque_paper'",
    );
    await cloneHeldCheque(cashed.transactionId, newerId, {
      chequeId: "chq_older_dup",
      chequeRef: "CHQ-OLDER-DUP",
      transactionId: "tx_older_dup",
      transactionRef: "CD-OLDER-DUP",
      hoursEarlier: 1,
    });

    await runMigrations(pool);

    const held = await pool.query(
      `SELECT cheque_id, status, paper_guard
         FROM ledger_cheques
        WHERE cheque_number = '1002841'
        ORDER BY created_at`,
    );
    expect(held.rows).toEqual([
      { cheque_id: "chq_older_dup", status: "held", paper_guard: false },
      { cheque_id: newerId, status: "held", paper_guard: true },
    ]);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM schema_migrations WHERE migration_id = '039_live_cheque_paper'",
        )
      ).rowCount,
    ).toBe(1);

    /* The newest copy is the one the index watches. A third live
       copy of the same paper still cannot land. */
    await expect(
      cloneHeldCheque(cashed.transactionId, newerId, {
        chequeId: "chq_third_dup",
        chequeRef: "CHQ-THIRD-DUP",
        transactionId: "tx_third_dup",
        transactionRef: "CD-THIRD-DUP",
        hoursEarlier: 0,
      }),
    ).rejects.toThrow(/duplicate key value|unique constraint/i);
  });
});

/** A second held row for a cheque that is already on the book.
    Used to build the duplicate this migration has to survive. */
async function cloneHeldCheque(
  sourceTransactionId: string,
  sourceChequeId: string,
  ids: {
    chequeId: string;
    chequeRef: string;
    transactionId: string;
    transactionRef: string;
    hoursEarlier: number;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE tmp_tx ON COMMIT DROP AS SELECT * FROM ledger_transactions WHERE transaction_id = $1",
      [sourceTransactionId],
    );
    await client.query(
      "UPDATE tmp_tx SET transaction_id = $1, transaction_ref = $2",
      [ids.transactionId, ids.transactionRef],
    );
    await client.query("INSERT INTO ledger_transactions SELECT * FROM tmp_tx");
    await client.query(
      "CREATE TEMP TABLE tmp_chq ON COMMIT DROP AS SELECT * FROM ledger_cheques WHERE cheque_id = $1",
      [sourceChequeId],
    );
    await client.query(
      `UPDATE tmp_chq
          SET cheque_id = $1,
              cheque_ref = $2,
              cashing_transaction_id = $3,
              created_at = created_at - ($4 * interval '1 hour')`,
      [ids.chequeId, ids.chequeRef, ids.transactionId, ids.hoursEarlier],
    );
    await client.query("INSERT INTO ledger_cheques SELECT * FROM tmp_chq");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
