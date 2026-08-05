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
     what it exists for. `unverified-walkin` is here for the one test that
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
) =>
  app.inject({
    method: "POST",
    url: `/api/ledger/cheques/${chequeId}/${leg}`,
    payload: {
      idempotencyKey: `${leg}-${Math.random().toString(36).slice(2)}`,
      ...body,
    },
    cookies,
  });

const tillCad = async () =>
  (
    await pool.query(
      "SELECT available_amount FROM ledger_till_balances WHERE till_id=$1 AND currency='CAD'",
      [TILL],
    )
  ).rows[0]?.available_amount ?? null;

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
       left behind would count toward another file's totals. */
    await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques CASCADE");
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
});
