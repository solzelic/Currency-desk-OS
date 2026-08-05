/* ============================================================
   The four lines that are cash on one side and a promise on the other.

   Every one of these assertions fails against the code as it was before
   `ObligationService` existed, for the plainest possible reason: there
   was no route, no table and no journal — a remittance moved cash in a
   browser array and the ledger never heard about it. What the file is
   really testing is the four things a money path has to get right and
   which a green suite has historically not proved: the journal balances,
   the drawer moves by the right amount in the right direction, an
   overdraw writes nothing at all, and undoing a mistake is not the same
   act as taking a loss.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { LedgerError, LedgerService, type LedgerActor } from "../src/ledger/service.js";
import { ObligationService } from "../src/ledger/obligations.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let handle: DbHandle;
let pool: pg.Pool;
let service: ObligationService;

const teller: LedgerActor = {
  userId: "teller-1", tenantId: "tenant-1", legalEntityId: "le-1", branchId: "branch-1",
  workspaceId: "workspace-1", tillId: "till-1", role: "teller", authorizedBranchIds: ["branch-1"],
};
/* Settling and writing off are not counter acts — they restate the profit
   on a deal that already happened, off a partner statement nobody at the
   counter can see — so they take `transaction:reverse` and a teller does
   not have it. */
const supervisor: LedgerActor = { ...teller, userId: "supervisor-1", role: "supervisor" };

const send = {
  idempotencyKey: "send-1",
  customerId: "customer-1",
  reference: "TR-260618-003",
  principalAmount: "600.00",
  feeAmount: "9.99",
  payoutCurrency: "PHP",
  payoutAmount: "24000.00",
  corridor: "PH",
  partner: "Cebuana Lhuillier",
  beneficiaryName: "Maria Carter",
  purpose: "Family support",
  sourceOfFunds: "Salary",
};
const receive = {
  idempotencyKey: "receive-1",
  customerId: "customer-1",
  reference: "TR-260618-011",
  sentCurrency: "PHP",
  sentAmount: "16000.00",
  payoutAmount: "400.00",
  feeAmount: "5.00",
  corridor: "PH",
  partner: "Cebuana Lhuillier",
  purpose: "Family support",
  sourceOfFunds: "Family abroad",
};
const bill = {
  idempotencyKey: "bill-1",
  customerId: "customer-1",
  reference: "BP-260618-002",
  billAmount: "150.00",
  feeAmount: "2.50",
  biller: "Toronto Hydro",
  accountRef: "44120-8891",
  purpose: "Utilities",
  sourceOfFunds: "Salary",
};
const order = {
  idempotencyKey: "mo-1",
  customerId: "customer-1",
  reference: "MO-260618-007",
  faceAmount: "300.00",
  feeAmount: "3.99",
  payee: "Landlord Holdings Ltd",
  serial: "MO-88431102",
  purpose: "Rent",
  sourceOfFunds: "Salary",
};

const OPENING_CAD = 25000;

async function reset() {
  await pool.query(
    "TRUNCATE ledger_obligation_events,ledger_obligations,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query(
    "INSERT INTO ledger_principals VALUES ('teller-1','tenant-1','le-1','branch-1','workspace-1','till-1','teller','[\"branch-1\"]'),('supervisor-1','tenant-1','le-1','branch-1','workspace-1','till-1','supervisor','[\"branch-1\"]')",
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-1','tenant-1','le-1','branch-1','workspace-1','Rachel Carter','normal','verified'),('customer-2','tenant-1','le-1','branch-1','workspace-1','Walk-in','normal','missing')",
  );
  await pool.query(
    "INSERT INTO ledger_rates VALUES ('tenant-1','le-1','branch-1','workspace-1','CAD',1),('tenant-1','le-1','branch-1','workspace-1','USD',0.731)",
  );
  await pool.query(
    "INSERT INTO ledger_till_balances VALUES ('tenant-1','le-1','branch-1','workspace-1','till-1','CAD',$1)",
    [OPENING_CAD],
  );
  await pool.query(
    "INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('session-1','tenant-1','le-1','branch-1','workspace-1','till-1',1,current_date,'open','teller-1',now())",
  );
}

const cad = () =>
  pool
    .query(
      "SELECT available_amount FROM ledger_till_balances WHERE till_id='till-1' AND currency='CAD'",
    )
    .then((r) => new Decimal(r.rows[0].available_amount));

/** The journal as a set of lines, which is what a reader checks. */
const journalOf = (transactionId: string) =>
  pool
    .query(
      "SELECT account_code,side,amount_cad FROM ledger_journal_entries WHERE transaction_id=$1 ORDER BY account_code,side",
      [transactionId],
    )
    .then((r) => r.rows);

/** Both sides of every journal on the book, which must always agree. */
async function bookBalances() {
  const totals = await pool.query(
    "SELECT side,coalesce(sum(amount_cad),0) AS amount FROM ledger_journal_entries GROUP BY side",
  );
  const of = (side: string) =>
    new Decimal(totals.rows.find((row) => row.side === side)?.amount ?? 0);
  return of("debit").eq(of("credit"));
}

postgres("obligation lines on a real PostgreSQL ledger", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    service = new ObligationService(pool);
    await pool.query(
      `INSERT INTO jurisdiction_packs
         (pack_id,jurisdiction,version,name,home_currency,regulator,
          report_name,report_threshold,id_threshold,report_currency,allow_cross_currency)
       VALUES ('pack-obl-v1','ZZ',1,'Obligation tests','CAD','TESTREG',
               'LCTR',10000,3000,'CAD',true)
       ON CONFLICT (pack_id) DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ('tenant-1','Obligation tests') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ('le-1','tenant-1','Obligation tests','CAD','pack-obl-v1',1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-obl-v1'`,
    );
  });
  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });
  beforeEach(reset);

  /* ---------------- remittance — send ---------------- */

  it("takes the cash in, books the payout as owed, and claims only the fee", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;

    /* CAD 600.00 for the transfer and CAD 9.99 for the fee, both in
       notes over the counter, so the drawer is 609.99 heavier. */
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("609.99").toFixed(2));

    expect(await journalOf(posted.transactionId!)).toEqual([
      { account_code: "liability:remittance_payable", side: "credit", amount_cad: "600.00" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "9.99" },
      { account_code: "till:CAD", side: "debit", amount_cad: "609.99" },
    ]);
    expect(await bookBalances()).toBe(true);

    /* No margin, anywhere. The desk sold pesos at its own price and has
       not yet bought them at the partner's, so there is nothing it can
       prove it earned beyond the fee. `spread_cad` is zero and means it. */
    const row = (
      await pool.query(
        "SELECT deal_kind,received_instrument,disbursed_instrument,cross_border,cash_in_home,cash_out_home,spread_cad,realized_pnl_home FROM ledger_transactions WHERE transaction_id=$1",
        [posted.transactionId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      deal_kind: "remittance_send",
      received_instrument: "cash",
      disbursed_instrument: "electronic_funds_transfer",
      cross_border: true,
      cash_in_home: "609.99",
      cash_out_home: "0.00",
      spread_cad: "0.00",
      realized_pnl_home: null,
    });

    const obligation = (
      await pool.query("SELECT * FROM ledger_obligations WHERE transaction_id=$1", [
        posted.transactionId,
      ])
    ).rows[0];
    expect(obligation).toMatchObject({
      kind: "remittance_payable",
      direction: "payable",
      status: "open",
      counterparty: "Cebuana Lhuillier",
      corridor: "PH",
      face_currency: "PHP",
      face_amount: "24000.00",
      /* What the desk actually took for the promise, not the payout
         translated at a mid — see docs/OBLIGATION_LINES.md. */
      carrying_amount_home: "600.00",
      settled_amount_home: null,
    });

    /* No foreign cash crossed the drawer, so there is no inventory and
       the cost engine has nothing to say. A cost event here would mean
       the ledger thought it had bought pesos it never touched. */
    expect((await pool.query("SELECT 1 FROM ledger_cost_events")).rowCount).toBe(0);
  });

  /* ---------------- remittance — receive ---------------- */

  it("pays the beneficiary out of the drawer against a receivable carrying the fee", async () => {
    const posted = (await service.remittanceReceive(teller, receive)) as Record<string, string>;

    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).sub("400.00").toFixed(2));
    expect(await journalOf(posted.transactionId!)).toEqual([
      { account_code: "asset:remittance_receivable", side: "debit", amount_cad: "405.00" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "5.00" },
      { account_code: "till:CAD", side: "credit", amount_cad: "400.00" },
    ]);
    expect(await bookBalances()).toBe(true);

    const row = (
      await pool.query(
        "SELECT deal_kind,received_instrument,disbursed_instrument,cash_in_home,cash_out_home,input_amount FROM ledger_transactions WHERE transaction_id=$1",
        [posted.transactionId],
      )
    ).rows[0];
    /* The distinction the compliance engine exists to be given: the input
       leg is 16,000 pesos a sender abroad dispatched, and the cash that
       crossed the counter is CAD 400 going OUT. A large cash rule reading
       the input leg would count this as four hundred dollars received. */
    expect(row).toMatchObject({
      deal_kind: "remittance_receive",
      received_instrument: "electronic_funds_transfer",
      disbursed_instrument: "cash",
      input_amount: "16000.00",
      cash_in_home: "0.00",
      cash_out_home: "400.00",
    });

    const obligation = (
      await pool.query("SELECT * FROM ledger_obligations WHERE transaction_id=$1", [
        posted.transactionId,
      ])
    ).rows[0];
    expect(obligation).toMatchObject({
      kind: "remittance_receivable",
      direction: "receivable",
      face_currency: "PHP",
      face_amount: "16000.00",
      carrying_amount_home: "405.00",
      status: "open",
    });
  });

  it("refuses a payout the drawer cannot cover, and writes nothing at all", async () => {
    await expect(
      service.remittanceReceive(teller, {
        ...receive,
        payoutAmount: String(OPENING_CAD + 1) + ".00",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_TILL_LIQUIDITY" });

    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).toFixed(2));
    expect((await pool.query("SELECT 1 FROM ledger_transactions")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM ledger_obligations")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM ledger_journal_entries")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM ledger_till_movements")).rowCount).toBe(0);
  });

  /* ---------------- bill payment and money order ---------------- */

  it("takes a bill payment in and owes the biller its face", async () => {
    const posted = (await service.billPayment(teller, bill)) as Record<string, string>;
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("152.50").toFixed(2));
    expect(await journalOf(posted.transactionId!)).toEqual([
      { account_code: "liability:bill_payable", side: "credit", amount_cad: "150.00" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "2.50" },
      { account_code: "till:CAD", side: "debit", amount_cad: "152.50" },
    ]);
    const obligation = (
      await pool.query("SELECT * FROM ledger_obligations WHERE transaction_id=$1", [
        posted.transactionId,
      ])
    ).rows[0];
    expect(obligation).toMatchObject({
      kind: "bill_payable",
      counterparty: "Toronto Hydro",
      reference: "44120-8891",
      /* Domestic. The corridor is NULL and `cross_border` is false, which
         is what keeps a bill payment out of an electronic funds transfer
         report that is about money leaving the country. */
      corridor: null,
      face_currency: "CAD",
      carrying_amount_home: "150.00",
    });
    expect(
      (
        await pool.query("SELECT cross_border FROM ledger_transactions WHERE transaction_id=$1", [
          posted.transactionId,
        ])
      ).rows[0].cross_border,
    ).toBe(false);
  });

  it("issues a money order against cash and owes whoever presents it", async () => {
    const posted = (await service.moneyOrder(teller, order)) as Record<string, string>;
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("303.99").toFixed(2));
    expect(await journalOf(posted.transactionId!)).toEqual([
      { account_code: "liability:money_order_payable", side: "credit", amount_cad: "300.00" },
      { account_code: "revenue:fee", side: "credit", amount_cad: "3.99" },
      { account_code: "till:CAD", side: "debit", amount_cad: "303.99" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT disbursed_instrument FROM ledger_transactions WHERE transaction_id=$1",
          [posted.transactionId],
        )
      ).rows[0].disbursed_instrument,
    ).toBe("money_order");
  });

  /* ---------------- the rules that hold for all four ---------------- */

  it("posts once for one idempotency key, however many times it is asked", async () => {
    const first = (await service.remittanceSend(teller, send)) as Record<string, string>;
    const second = (await service.remittanceSend(teller, send)) as Record<string, string>;
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.obligationId).toBe(first.obligationId);
    expect((await pool.query("SELECT 1 FROM ledger_transactions")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM ledger_obligations")).rowCount).toBe(1);
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("609.99").toFixed(2));
  });

  it("refuses every one of them while the till is shut", async () => {
    /* Closed the way the table insists a session is closed — with a
       person and a time on it, because a shut drawer nobody shut is not
       a state this ledger permits. */
    await pool.query(
      "UPDATE ledger_till_sessions SET status='closed',closed_by='teller-1',closed_at=now() WHERE session_id='session-1'",
    );
    for (const attempt of [
      () => service.remittanceSend(teller, send),
      () => service.remittanceReceive(teller, receive),
      () => service.billPayment(teller, bill),
      () => service.moneyOrder(teller, order),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: "TILL_NOT_OPEN" });
    expect((await pool.query("SELECT 1 FROM ledger_transactions")).rowCount).toBe(0);
  });

  it("applies the desk's identification line to the cash, in either direction", async () => {
    /* The pack identifies at 3,000, and this customer has no ID on file.
       A four-thousand-dollar remittance is refused going out over the
       counter exactly as it is coming in — knowing who you handed the
       money to is not a rule about which way it was walking. */
    await expect(
      service.remittanceSend(teller, {
        ...send,
        customerId: "customer-2",
        principalAmount: "4000.00",
        payoutAmount: "160000.00",
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    await expect(
      service.remittanceReceive(teller, {
        ...receive,
        customerId: "customer-2",
        payoutAmount: "4000.00",
        sentAmount: "160000.00",
      }),
    ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    expect((await pool.query("SELECT 1 FROM ledger_transactions")).rowCount).toBe(0);
  });

  /* ---------------- undoing a mistake ---------------- */

  it("puts a mis-keyed send back exactly, and touches no profit and loss", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    const undone = (await service.reverse(
      supervisor,
      posted.transactionId!,
      "reverse-1",
      "Keyed against the wrong beneficiary",
    )) as Record<string, string>;

    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).toFixed(2));
    expect(
      (await pool.query("SELECT status,reversal_id FROM ledger_obligations")).rows[0],
    ).toMatchObject({ status: "reversed", reversal_id: undone.reversalId });

    /* The mirror, and nothing else. A reversal that wrote to a margin or
       an expense account would make a typing mistake read as a corridor
       that lost money. */
    const mirrored = await pool.query(
      "SELECT account_code,side,amount_cad FROM ledger_reversal_entries WHERE reversal_id=$1 ORDER BY account_code",
      [undone.reversalId],
    );
    expect(mirrored.rows).toEqual([
      { account_code: "liability:remittance_payable", side: "debit", amount_cad: "600.00" },
      { account_code: "revenue:fee", side: "debit", amount_cad: "9.99" },
      { account_code: "till:CAD", side: "credit", amount_cad: "609.99" },
    ]);
    expect(
      (await pool.query("SELECT 1 FROM ledger_obligation_events WHERE kind='reversed'")).rowCount,
    ).toBe(1);
    /* No write-off, no settlement, no expense. */
    expect(
      (
        await pool.query(
          "SELECT 1 FROM ledger_journal_entries WHERE account_code LIKE 'expense:%' OR account_code LIKE '%margin%'",
        )
      ).rowCount,
    ).toBe(0);
  });

  it("refuses to let the exchange reversal path half-undo one of these", async () => {
    /* `LedgerService.reverse` knows about cost events and nothing about
       obligations. Left open to these deals it would mirror the cash and
       the journal and leave the payout still owed — a hole in the book
       that balances perfectly, which is the worst kind there is. */
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    const exchanges = new LedgerService(pool);
    await expect(
      exchanges.reverse(supervisor, posted.transactionId!, "reverse-x", "Wrong beneficiary"),
    ).rejects.toMatchObject({ code: "REVERSAL_NOT_ALLOWED" });
    expect((await pool.query("SELECT status FROM ledger_obligations")).rows[0].status).toBe("open");
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("609.99").toFixed(2));
  });

  it("refuses to reverse a deal whose obligation has already been discharged", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-1",
      amountHome: "578.40",
    });
    await expect(
      service.reverse(supervisor, posted.transactionId!, "reverse-2", "Too late"),
    ).rejects.toMatchObject({ code: "REVERSAL_NOT_ALLOWED" });
  });

  it("refuses a reversal the drawer can no longer fund, and leaves the obligation open", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    /* The day's takings went to the vault before anybody noticed the
       mistake. The cash has to come back out of this drawer and it is
       not there, so the reversal is refused rather than driving the
       balance negative. */
    await pool.query(
      "UPDATE ledger_till_balances SET available_amount=100 WHERE till_id='till-1' AND currency='CAD'",
    );
    await expect(
      service.reverse(supervisor, posted.transactionId!, "reverse-3", "Wrong beneficiary"),
    ).rejects.toMatchObject({ code: "REVERSAL_NOT_ALLOWED" });
    expect((await pool.query("SELECT status FROM ledger_obligations")).rows[0].status).toBe("open");
    expect((await cad()).toFixed(2)).toBe("100.00");
  });

  /* ---------------- and here, at last, the margin ---------------- */

  it("recognizes the rate margin when the payout is finally bought, and not before", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    /* The corridor partner funded 24,000 pesos for CAD 578.40. THAT is a
       price the desk paid, and the 21.60 between it and what the customer
       paid is the margin — the first honest figure in the whole life of
       this deal. */
    const settled = (await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-2",
      amountHome: "578.40",
      reference: "CEB-BATCH-2211",
    })) as Record<string, string>;
    expect(settled.marginHome).toBe("21.60");

    expect(await journalOf(settled.transactionId!)).toEqual([
      { account_code: "asset:bank_clearing", side: "credit", amount_cad: "578.40" },
      { account_code: "liability:remittance_payable", side: "debit", amount_cad: "600.00" },
      { account_code: "revenue:remittance_margin", side: "credit", amount_cad: "21.60" },
    ]);
    expect(await bookBalances()).toBe(true);

    /* Not a counter deal, and the row says so — a settlement counted as a
       deal would put this remittance in the day's volume twice. */
    const row = (
      await pool.query("SELECT deal_kind,cash_in_home,cash_out_home FROM ledger_transactions WHERE transaction_id=$1", [
        settled.transactionId,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      deal_kind: "obligation_settlement",
      cash_in_home: "0.00",
      cash_out_home: "0.00",
    });
    /* Nothing over the counter. */
    expect((await cad()).toFixed(2)).toBe(new Decimal(OPENING_CAD).add("609.99").toFixed(2));
    expect(
      (await pool.query("SELECT status,settled_amount_home FROM ledger_obligations")).rows[0],
    ).toMatchObject({ status: "settled", settled_amount_home: "578.40" });
  });

  it("books a corridor that cost more than it sold for as the loss it is", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    const settled = (await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-3",
      amountHome: "612.00",
    })) as Record<string, string>;
    expect(settled.marginHome).toBe("-12.00");
    expect(await journalOf(settled.transactionId!)).toContainEqual({
      account_code: "revenue:remittance_margin",
      side: "debit",
      amount_cad: "12.00",
    });
    expect(await bookBalances()).toBe(true);
  });

  it("settles a receivable short and calls the shortfall a loss on the margin", async () => {
    const posted = (await service.remittanceReceive(teller, receive)) as Record<string, string>;
    const settled = (await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-4",
      amountHome: "402.00",
    })) as Record<string, string>;
    expect(settled.marginHome).toBe("-3.00");
    expect(await journalOf(settled.transactionId!)).toEqual([
      { account_code: "asset:bank_clearing", side: "debit", amount_cad: "402.00" },
      { account_code: "asset:remittance_receivable", side: "credit", amount_cad: "405.00" },
      { account_code: "revenue:remittance_margin", side: "debit", amount_cad: "3.00" },
    ]);
    expect(await bookBalances()).toBe(true);
  });

  /* ---------------- and a loss that is not a mistake ---------------- */

  it("writes a defaulted receivable off to an expense, and restores no cash", async () => {
    const posted = (await service.remittanceReceive(teller, receive)) as Record<string, string>;
    const before = await cad();
    const written = (await service.writeOff(supervisor, posted.obligationId!, {
      idempotencyKey: "writeoff-1",
      reason: "Partner ceased trading; funding never arrived",
    })) as Record<string, string>;

    expect(written.marginHome).toBe("-405.00");
    expect(await journalOf(written.transactionId!)).toEqual([
      { account_code: "asset:remittance_receivable", side: "credit", amount_cad: "405.00" },
      { account_code: "expense:remittance_losses", side: "debit", amount_cad: "405.00" },
    ]);
    /* The cash went out of the door and it is not coming back. A
       write-off that moved a till would be the desk inventing money. */
    expect((await cad()).toFixed(2)).toBe(before.toFixed(2));
    expect((await pool.query("SELECT status FROM ledger_obligations")).rows[0].status).toBe(
      "written_off",
    );
    expect(await bookBalances()).toBe(true);
  });

  it("refuses to write off a payable, because dormancy is nobody here's rule", async () => {
    const posted = (await service.moneyOrder(teller, order)) as Record<string, string>;
    await expect(
      service.writeOff(supervisor, posted.obligationId!, {
        idempotencyKey: "writeoff-2",
        reason: "Never presented",
      }),
    ).rejects.toMatchObject({ code: "OBLIGATION_NOT_WRITABLE_OFF" });
    expect((await pool.query("SELECT status FROM ledger_obligations")).rows[0].status).toBe("open");
  });

  it("settles once for one idempotency key", async () => {
    const posted = (await service.billPayment(teller, bill)) as Record<string, string>;
    const first = (await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-5",
      amountHome: "150.00",
    })) as Record<string, string>;
    const second = (await service.settle(supervisor, posted.obligationId!, {
      idempotencyKey: "settle-5",
      amountHome: "150.00",
    })) as Record<string, string>;
    expect(second.transactionId).toBe(first.transactionId);
    expect(
      (await pool.query("SELECT 1 FROM ledger_obligation_events WHERE kind='settled'")).rowCount,
    ).toBe(1);
    /* A bill remitted for exactly its face earns nothing beyond the fee
       already taken, so there is no margin line at all — a journal entry
       for nothing is noise. */
    expect(await journalOf(first.transactionId!)).toEqual([
      { account_code: "asset:bank_clearing", side: "credit", amount_cad: "150.00" },
      { account_code: "liability:bill_payable", side: "debit", amount_cad: "150.00" },
    ]);
  });

  it("will not let a teller restate the profit on a deal that already happened", async () => {
    const posted = (await service.remittanceSend(teller, send)) as Record<string, string>;
    await expect(
      service.settle(teller, posted.obligationId!, {
        idempotencyKey: "settle-6",
        amountHome: "578.40",
      }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  it("reports what is open, per side, and nothing where there is nothing", async () => {
    await service.remittanceSend(teller, send);
    await service.remittanceReceive(teller, receive);
    await service.billPayment(teller, bill);
    const open = (await service.list(teller, { status: "open", limit: 100 })) as {
      obligations: unknown[];
      outstanding: { payable: string | null; receivable: string | null };
    };
    expect(open.obligations).toHaveLength(3);
    /* 600.00 owed on the corridor plus 150.00 owed to the biller. */
    expect(open.outstanding.payable).toBe("750.00");
    expect(open.outstanding.receivable).toBe("405.00");

    await reset();
    const empty = (await service.list(teller, { limit: 100 })) as {
      outstanding: { payable: string | null; receivable: string | null };
    };
    /* Null, not zero. A desk that has never taken a remittance has no
       payable position, and "0.00" is a claim about a book nobody has
       written in — docs/ABSENT_FIGURES.md. */
    expect(empty.outstanding).toEqual({ payable: null, receivable: null });
  });
});
