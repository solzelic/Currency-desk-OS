/* ============================================================
   Cheque cashing, on the one book.

   Cheque cashing is one of six deal types this product sells and it was
   one of five that moved drawer cash without the server ever hearing
   about it: `save()` in os-src/cdos-cheques.jsx built a row, pushed it
   into an array, and wrote a cheque record into localStorage. The
   module's own header claimed the cashing "posts a ledger row … so cash,
   fees and the audit trail stay on the one source of truth". It did not.
   This file is what makes that sentence true, and it is the first of the
   five to come across, so the shape here is the shape the rest inherit.

   ---- CASHING A CHEQUE IS NOT A SALE ----

   The desk fronts cash against a receivable it hopes will clear. What it
   is holding afterwards is not money, it is somebody else's promise, and
   a journal that does not show that cannot answer the only question this
   product line raises: how much of the desk's cash is out of the door on
   paper that has not settled.

   So there are three events and three journals, and they are written down
   in full in docs/CHEQUE_CASHING.md with a worked example. In short:

     cashing    asset:cheques_held    debit  face      the receivable
                till:<home>           credit net       cash out of the drawer
                revenue:cheque_fee    credit fee

     clearing   asset:bank_clearing   debit  face
                asset:cheques_held    credit face      no till movement

     returned   expense:cheque_losses debit  face
                asset:cheques_held    credit face      the fee is NOT reversed

   ---- THERE IS NO COST EVENT HERE. ANYWHERE. ----

   Somebody will eventually read this file, notice that every other
   posting path in the ledger books a cost basis, and "fix" the omission.
   It is not an omission. The cash the desk pays out is its own home
   currency, whose cost is 1 by definition — it is the unit everything
   else is measured in (docs/COST_BASIS.md, "The home currency"). There is
   no average to move, no lot to draw down, and no margin to realize on
   that leg. The fee is fee revenue, not a margin against a purchase, and
   an NSF is an expense, not a loss on inventory. Booking a cost event
   against home-currency cash would put a basis on the measuring stick.

   A foreign-currency cheque WOULD have inventory in it, because paying a
   customer home currency for a US dollar cheque is an exchange as well as
   a cheque. That deal needs the quote path and is refused here outright —
   see `CHEQUE_CURRENCY_NOT_HOME` below — rather than mis-posted quietly.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type pg from "pg";
import { resolvePack } from "./jurisdiction.js";
import { authorizeLedgerActor } from "./principal.js";
import { withSerializationRetry } from "./retry.js";
import {
  LedgerError,
  requireIdentification,
  requireOpenTill,
  type LedgerActor,
} from "./service.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/* Transaction rows that SETTLE a deal rather than being one.

   A clearance and a return each write a journal, so each needs a
   transaction row to hang it off — that is how every other journal on
   this ledger is read, and giving cheque settlements a private format
   would be a second journal. But they are not deals: one cheque cashed,
   cleared and then reversed would otherwise appear three times in a day's
   volume and three times in a teller's deal count.

   Defined once, here, and imported by everything that totals or lists
   transactions. A copy of this list somewhere else is the beginning of
   the next disagreement. */
export const SETTLEMENT_DEAL_KINDS = [
  "cheque_clearing",
  "cheque_return",
] as const;

/* The same list as a SQL literal, for the queries that have to exclude
   them. Built from the array above so the two can never drift. */
export const SETTLEMENT_DEAL_KINDS_SQL = SETTLEMENT_DEAL_KINDS.map(
  (kind) => `'${kind}'`,
).join(",");

export type ChequeStatus = "held" | "cleared" | "returned" | "reversed";

export type ChequeCashInput = {
  idempotencyKey: string;
  customerId: string;
  chequeNumber: string;
  maker: string;
  draweeBank?: string | null;
  chequeType: string;
  typeLabel: string;
  currency: string;
  faceAmount: string;
  feeAmount: string;
  holdDays: number;
  endorsed?: boolean;
  purpose?: string;
  sourceOfFunds?: string;
};

export type ChequeSettlementInput = {
  idempotencyKey: string;
  note?: string;
  reference?: string;
};

export type ChequeReturnInput = ChequeSettlementInput & {
  /* Why it came back. `nsf` and `fraud` are the two the desk acts on
     differently — one is a customer who will be chased, the other is a
     file that goes to compliance — and both are still a return. */
  nsf?: boolean;
  fraud?: boolean;
  reason: string;
};

export type ChequeReversalInput = {
  idempotencyKey: string;
  reason: string;
};

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

const money = (value: string, minimum: Decimal.Value) => {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new LedgerError("INVALID_REQUEST", "Invalid decimal amount.");
  const out = new Decimal(value);
  if (out.lt(minimum) || out.gt("1000000000"))
    throw new LedgerError(
      "INVALID_REQUEST",
      "Amount outside the permitted range.",
    );
  return out.toDecimalPlaces(2);
};
const fixed = (value: Decimal.Value, places = 2) =>
  new Decimal(value).toDecimalPlaces(places).toFixed(places);

const dateOnly = (value: unknown) =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);

/** One cheque, in the shape the desk's screens already speak. */
const chequeJson = (row: Record<string, any>) => ({
  chequeId: String(row.cheque_id),
  ref: String(row.cheque_ref),
  customerId: String(row.customer_id),
  chequeNumber: String(row.cheque_number),
  maker: String(row.maker),
  draweeBank: row.drawee_bank ?? null,
  chequeType: String(row.cheque_type),
  typeLabel: String(row.type_label),
  currency: String(row.currency).trim(),
  faceAmount: fixed(row.face_amount),
  feeAmount: fixed(row.fee_amount),
  netAmount: fixed(row.net_amount),
  holdDays: Number(row.hold_days),
  holdUntil: dateOnly(row.hold_until),
  receivedDate: dateOnly(row.received_date),
  endorsed: !!row.endorsed,
  status: String(row.status) as ChequeStatus,
  nsf: !!row.nsf,
  fraud: !!row.fraud,
  returnedReason: row.returned_reason ?? null,
  cashingTransactionId: String(row.cashing_transaction_id),
  cashingTransactionRef: row.cashing_transaction_ref ?? null,
  settlementTransactionId: row.settlement_transaction_id ?? null,
  reversalId: row.reversal_id ?? null,
  createdBy: String(row.created_by),
  createdAt: new Date(row.created_at).toISOString(),
});

export class ChequeService {
  constructor(private readonly pool: pg.Pool) {}

  /* Every entry point below is retried on a serialization failure, for
     the reason written down in retry.ts: these transactions take the
     till's balance row and the till session at SERIALIZABLE, so they
     abort whenever anything else touches the same drawer — including the
     screen behind the teller refreshing its balances. Nothing is
     committed when they do, and the idempotency key makes the second
     attempt land on the duplicate path rather than posting twice. */

  cash(actor: LedgerActor, input: ChequeCashInput) {
    return withSerializationRetry(() => this.cashOnce(actor, input));
  }

  clear(actor: LedgerActor, chequeId: string, input: ChequeSettlementInput) {
    return withSerializationRetry(() =>
      this.settleOnce(actor, chequeId, input, "cleared"));
  }

  returnUnpaid(actor: LedgerActor, chequeId: string, input: ChequeReturnInput) {
    return withSerializationRetry(() =>
      this.settleOnce(actor, chequeId, input, "returned"));
  }

  reverseCashing(
    actor: LedgerActor,
    chequeId: string,
    input: ChequeReversalInput,
  ) {
    return withSerializationRetry(() =>
      this.reverseCashingOnce(actor, chequeId, input));
  }

  /* ------------------------------------------------------------------
     THE REGISTER
     ------------------------------------------------------------------ */

  /**
   * Every cheque this branch is carrying, newest first.
   *
   * Scoped to the BRANCH rather than to the till. Outstanding exposure is
   * the desk's credit risk, not one drawer's: a cheque cashed at till 1
   * is still the branch's money out of the door when the person looking
   * at the screen is sitting at till 2. Filed reports are scoped the same
   * way and for the same reason (report-filings.ts).
   */
  async list(actor: LedgerActor, limit = 200) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const rows = await client.query(
        `SELECT c.*, t.transaction_ref AS cashing_transaction_ref
           FROM ledger_cheques c
           JOIN ledger_transactions t ON t.transaction_id = c.cashing_transaction_id
          WHERE c.tenant_id=$1 AND c.legal_entity_id=$2 AND c.branch_id=$3
          ORDER BY c.received_date DESC, c.created_at DESC
          LIMIT $4`,
        [actor.tenantId, actor.legalEntityId, actor.branchId, limit],
      );
      const events = await client.query(
        `SELECT e.*
           FROM ledger_cheque_events e
           JOIN ledger_cheques c ON c.cheque_id = e.cheque_id
          WHERE c.tenant_id=$1 AND c.legal_entity_id=$2 AND c.branch_id=$3
          ORDER BY e.created_at, e.event_id`,
        [actor.tenantId, actor.legalEntityId, actor.branchId],
      );
      await client.query("COMMIT");
      const timeline = new Map<string, unknown[]>();
      for (const event of events.rows) {
        const list = timeline.get(event.cheque_id) ?? [];
        list.push({
          status: String(event.status),
          actorId: String(event.actor_id),
          note: event.note ?? null,
          transactionId: event.transaction_id ?? null,
          at: new Date(event.created_at).toISOString(),
        });
        timeline.set(event.cheque_id, list);
      }
      return {
        branchId: actor.branchId,
        cheques: rows.rows.map((row) => ({
          ...chequeJson(row),
          timeline: timeline.get(row.cheque_id) ?? [],
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------
     CASHING — cash leaves the drawer against a receivable
     ------------------------------------------------------------------ */

  private async cashOnce(actor: LedgerActor, input: ChequeCashInput) {
    if (!input.idempotencyKey)
      throw new LedgerError("INVALID_REQUEST", "Idempotency key is required.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "transaction:post");
      /* A drawer that is not open cannot pay anybody. Same gate an
         exchange passes, from the same function — see the note above
         `requireOpenTill` in service.ts about why it stopped being a
         private method the day a second deal type needed it. */
      await requireOpenTill(client, actor);

      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='cheque-cash' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), input.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'cheque-cash',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), input.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }

      const pack = await resolvePack(client, actor.legalEntityId);
      const home = pack.homeCurrency;
      const currency = String(input.currency ?? "").trim().toUpperCase();
      /* IN SCOPE: a cheque written in the currency the desk's book is kept
         in. Anything else is an exchange AND a cheque — the desk would be
         buying US dollars at some rate while also fronting cash against
         them — and that deal has to be priced through the quote path so
         the rate is frozen, the board publication is recorded and the
         inventory gets a cost. Refused by name rather than mis-posted at
         an implied rate of 1, which is what "just let it through" means
         here and would hand the customer a thousand Canadian dollars for
         a thousand-dollar American cheque. */
      if (currency !== home)
        throw new LedgerError(
          "CHEQUE_CURRENCY_NOT_HOME",
          `This desk keeps its book in ${home} and this cheque is written in ${currency || "an unstated currency"}. A foreign-currency cheque is an exchange as well as a cheque: quote it on the exchange path so the rate is frozen and recorded, then cash it. Nothing was posted.`,
        );

      const face = money(input.faceAmount, "0.01");
      const fee = money(input.feeAmount, "0");
      const net = face.minus(fee);
      if (net.lt(0))
        throw new LedgerError(
          "INVALID_REQUEST",
          "The fee cannot be larger than the cheque.",
        );
      const holdDays = Number(input.holdDays ?? 0);
      if (!Number.isInteger(holdDays) || holdDays < 0 || holdDays > 365)
        throw new LedgerError(
          "INVALID_REQUEST",
          "A hold is a whole number of days between 0 and 365.",
        );

      const customer = await client.query(
        "SELECT name,id_status FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 FOR UPDATE",
        [input.customerId, ...scope(actor).slice(0, 4)],
      );
      if (!customer.rowCount)
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "Customer is not in the active workspace.",
        );
      /* The desk's identification line does not become optional because
         the customer handed over paper instead of notes. The deal's size
         is the FACE amount — that is what is being presented and what the
         desk is exposed to — and the line is the desk's own, resolved
         exactly as it is for an exchange. */
      await requireIdentification(
        client,
        actor,
        pack,
        face,
        customer.rows[0].id_status,
      );

      /* The desk's own working day, from the till session rather than
         from this server's clock or the browser's. A cheque received on
         Friday evening at a branch keeping Friday's business date is a
         Friday cheque, and the hold runs from there. */
      const session = await client.query(
        `SELECT business_date FROM ledger_till_sessions
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND workspace_id=$4 AND till_id=$5
          ORDER BY session_number DESC LIMIT 1`,
        scope(actor),
      );
      const businessDate = dateOnly(session.rows[0].business_date);

      /* THE GUARD THIS DEAL TYPE EXISTS TO NEED. Cashing takes cash OUT
         of the drawer, so a drawer that has not got it must refuse — the
         same check, in the same order, as the destination-liquidity check
         in postFrozenQuote. Read here under FOR UPDATE so the refusal is
         a clean 422 with a message, and enforced again by the balance
         UPDATE's own `>= 0` predicate further down, which is what makes
         it impossible rather than merely checked. */
      const drawer = await client.query(
        "SELECT available_amount FROM ledger_till_balances WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6 FOR UPDATE",
        [...scope(actor), home],
      );
      if (
        !drawer.rowCount ||
        new Decimal(drawer.rows[0].available_amount).lt(net)
      )
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Insufficient till liquidity.",
        );

      const now = new Date();
      const transactionId = `tx_${randomUUID()}`;
      const transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;
      const chequeId = `chq_${randomUUID()}`;

      /* The desk's own reference, minted HERE. The browser used to mint
         it from the length of its own cheque list, which means two tills
         cashing at once both produce CHQ-260618-003 and the second one
         quietly overwrites nothing at all — they simply both claim the
         same name for different money. The count runs inside a
         SERIALIZABLE transaction, so a concurrent cashing aborts and
         retries rather than duplicating, and the unique index on
         (tenant, entity, branch, ref) is the backstop underneath that. */
      const sameDay = await client.query(
        `SELECT count(*)::int AS taken FROM ledger_cheques
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
            AND received_date=$4`,
        [actor.tenantId, actor.legalEntityId, actor.branchId, businessDate],
      );
      const chequeRef = `CHQ-${businessDate.slice(2).replace(/-/g, "")}-${String(
        Number(sameDay.rows[0].taken) + 1,
      ).padStart(3, "0")}`;

      /* ---- the journal ----

         Balances because face = net + fee, which the database itself
         enforces on the cheque row below rather than leaving it to
         arithmetic here. No cost event, no realized P&L, no touch of
         `avg_cost`: see the header of this file. */
      const journal = [
        ["asset:cheques_held", "debit", face],
        [`till:${home}`, "credit", net],
        ["revenue:cheque_fee", "credit", fee],
      ] as const;
      assertBalanced(journal, "Cheque cashing journal is unbalanced.");

      await this.writeTransaction(client, actor, {
        transactionId,
        transactionRef,
        customerId: input.customerId,
        home,
        packId: pack.packId,
        packVersion: pack.version,
        inputAmount: face,
        outputAmount: net,
        fee,
        purpose: (input.purpose ?? "").trim(),
        sourceOfFunds: (input.sourceOfFunds ?? "").trim(),
        dealKind: "cheque_cashing",
        /* WHAT ACTUALLY HAPPENED AT THE COUNTER, recorded as fact.
           A cheque came in; cash went out. Every amount column on this
           row says CAD 1,000 in and CAD 965 out, and a compliance engine
           reading those alone would conclude the desk RECEIVED a
           thousand dollars of cash, which is the opposite of the truth
           in both halves. Whether that creates a reporting obligation is
           the jurisdiction pack's question and is deliberately not
           answered here — but the pack now has a true fact to ask it
           about. */
        receivedInstrument: "cheque",
        disbursedInstrument: "cash",
        now,
      });
      for (const [account, side, amount] of journal)
        await client.query(
          "INSERT INTO ledger_journal_entries (transaction_id,account_code,side,amount_cad,amount_home,home_currency,created_at) VALUES ($1,$2,$3,$4,$4,$5,$6)",
          [transactionId, account, side, fixed(amount), home, now],
        );

      /* The cash physically leaves. The `>= 0` predicate is the real
         guard — a balance check and a balance update in two statements
         is a race, and this makes the drawer's own row refuse. */
      const moved = await client.query(
        "UPDATE ledger_till_balances SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1>=0",
        [fixed(net.neg()), ...scope(actor), home],
      );
      if (!moved.rowCount)
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Till movement rejected.",
        );
      await client.query(
        "INSERT INTO ledger_till_movements (transaction_id,movement_kind,currency,direction,amount,created_at) VALUES ($1,'original',$2,'out',$3,$4)",
        [transactionId, home, fixed(net), now],
      );

      const holdUntil = addDays(businessDate, holdDays);
      await client.query(
        `INSERT INTO ledger_cheques
           (cheque_id,cheque_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
            customer_id,cheque_number,maker,drawee_bank,cheque_type,type_label,currency,
            face_amount,fee_amount,net_amount,hold_days,hold_until,received_date,endorsed,
            status,cashing_transaction_id,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 'held',$22,$23,$24,$24)`,
        [
          chequeId,
          chequeRef,
          ...scope(actor),
          input.customerId,
          String(input.chequeNumber ?? "").trim(),
          String(input.maker ?? "").trim(),
          input.draweeBank ? String(input.draweeBank).trim() : null,
          String(input.chequeType ?? "").trim(),
          String(input.typeLabel ?? "").trim(),
          home,
          fixed(face),
          fixed(fee),
          fixed(net),
          holdDays,
          holdUntil,
          businessDate,
          !!input.endorsed,
          transactionId,
          actor.userId,
          now,
        ],
      );
      await this.writeChequeEvent(client, {
        chequeId,
        status: "held",
        actorId: actor.userId,
        note: `Cash fronted ${fixed(net)} ${home} · ${holdDays === 0 ? "no hold" : `${holdDays}-day hold`}`,
        transactionId,
        now,
      });
      await this.writeAudit(client, actor, "cheque.cash", chequeId, null, input.idempotencyKey, now);

      const response = {
        cheque: {
          chequeId,
          ref: chequeRef,
          customerId: input.customerId,
          chequeNumber: String(input.chequeNumber ?? "").trim(),
          maker: String(input.maker ?? "").trim(),
          draweeBank: input.draweeBank ? String(input.draweeBank).trim() : null,
          chequeType: String(input.chequeType ?? "").trim(),
          typeLabel: String(input.typeLabel ?? "").trim(),
          currency: home,
          faceAmount: fixed(face),
          feeAmount: fixed(fee),
          netAmount: fixed(net),
          holdDays,
          holdUntil,
          receivedDate: businessDate,
          endorsed: !!input.endorsed,
          status: "held" as ChequeStatus,
          nsf: false,
          fraud: false,
          returnedReason: null,
          cashingTransactionId: transactionId,
          cashingTransactionRef: transactionRef,
          settlementTransactionId: null,
          reversalId: null,
          createdBy: actor.userId,
          createdAt: now.toISOString(),
        },
        transactionId,
        transactionRef,
        postedAt: now.toISOString(),
        /* The drawer's new figure, in the same response that moved it.
           The client is forbidden from computing cash and this is what
           it renders instead — see docs/CASH_OWNERSHIP_INVARIANTS.md,
           "every movement of money is a server call that returns the new
           state". */
        balances: await this.tillBalances(client, actor),
      };
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='cheque-cash' AND idempotency_key=$7",
        [response, ...scope(actor), input.idempotencyKey],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------
     CLEARING AND RETURNING — the receivable is discharged, one way or
     the other, and NEITHER of them touches the drawer
     ------------------------------------------------------------------ */

  private async settleOnce(
    actor: LedgerActor,
    chequeId: string,
    input: ChequeSettlementInput | ChequeReturnInput,
    outcome: "cleared" | "returned",
  ) {
    if (!input.idempotencyKey)
      throw new LedgerError("INVALID_REQUEST", "Idempotency key is required.");
    const returning = outcome === "returned";
    const returnInput = input as ChequeReturnInput;
    if (returning && !String(returnInput.reason ?? "").trim())
      throw new LedgerError(
        "INVALID_REQUEST",
        "A returned cheque needs a reason — it is a loss the desk has to explain.",
      );
    const operation = returning ? "cheque-return" : "cheque-clear";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      /* `transaction:post` and NOT an open till. Neither of these events
         moves drawer cash — the money either arrives at the bank or is
         gone — so demanding an open session would stop somebody clearing
         yesterday's cheques before the counter opens, which is when that
         work actually gets done. The reversal below is the opposite case
         and does demand one, because cash goes back in the drawer. */
      await authorizeLedgerActor(client, actor, "transaction:post");

      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation=$6 AND idempotency_key=$7 FOR UPDATE",
        [...scope(actor), operation, input.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [...scope(actor), operation, input.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }

      const cheque = await this.lockHeldCheque(client, actor, chequeId);
      const home = String(cheque.currency).trim();
      const face = new Decimal(cheque.face_amount);
      const now = new Date();
      const transactionId = `tx_${randomUUID()}`;
      const transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;

      /* ---- the two settlement journals ----

         Clearing: the receivable becomes funds at the bank. The drawer is
         not involved and never was — the money the desk fronted left it
         on the day of the cashing.

         Returned: the receivable becomes an expense. The desk is out the
         face amount.

         THE FEE IS NOT REVERSED ON A RETURN, and a future reader will
         wonder, so: the desk did the work. It examined the paper, took
         the risk, handed over the cash and now has to chase it. Keeping
         the cashing fee on a bounced cheque is ordinary practice across
         the industry, and it is also what the journal above already says
         happened — `revenue:cheque_fee` was credited at the counter and
         nothing here contradicts it. A desk that wants to refund a fee as
         a gesture does that as its own deliberate act, not as a silent
         side effect of a cheque bouncing. */
      const journal = returning
        ? ([
            ["expense:cheque_losses", "debit", face],
            ["asset:cheques_held", "credit", face],
          ] as const)
        : ([
            ["asset:bank_clearing", "debit", face],
            ["asset:cheques_held", "credit", face],
          ] as const);
      assertBalanced(
        journal,
        returning
          ? "Cheque return journal is unbalanced."
          : "Cheque clearing journal is unbalanced.",
      );

      const pack = await resolvePack(client, actor.legalEntityId);
      await this.writeTransaction(client, actor, {
        transactionId,
        transactionRef,
        customerId: String(cheque.customer_id),
        home,
        packId: pack.packId,
        packVersion: pack.version,
        inputAmount: face,
        outputAmount: face,
        fee: new Decimal(0),
        /* Empty, and deliberately so. `purpose` and `source_of_funds` are
           what the CUSTOMER said at the counter about a deal they were
           doing. Nobody is at the counter for a clearance; putting
           "cheque cleared" in a compliance capture field would be the
           worksheet asserting a fact nobody stated, which is the exact
           defect this change is careful about elsewhere. */
        purpose: "",
        sourceOfFunds: "",
        dealKind: returning ? "cheque_return" : "cheque_clearing",
        /* No cash crossed the counter either way. On a clearance the
           funds arrive at the BANK; on a return nothing arrives at all. */
        receivedInstrument: returning ? "none" : "bank_credit",
        disbursedInstrument: "none",
        now,
      });
      for (const [account, side, amount] of journal)
        await client.query(
          "INSERT INTO ledger_journal_entries (transaction_id,account_code,side,amount_cad,amount_home,home_currency,created_at) VALUES ($1,$2,$3,$4,$4,$5,$6)",
          [transactionId, account, side, fixed(amount), home, now],
        );

      const reason = returning ? String(returnInput.reason).trim() : null;
      await client.query(
        `UPDATE ledger_cheques
            SET status=$1, nsf=$2, fraud=$3, returned_reason=$4,
                settlement_transaction_id=$5, updated_at=$6
          WHERE cheque_id=$7`,
        [
          outcome,
          returning && !!returnInput.nsf,
          returning && !!returnInput.fraud,
          reason,
          transactionId,
          now,
          chequeId,
        ],
      );
      await this.writeChequeEvent(client, {
        chequeId,
        status: outcome,
        actorId: actor.userId,
        note:
          String(input.note ?? "").trim() ||
          (returning
            ? `${reason} · ${fixed(face)} ${home} written off`
            : `Funds confirmed by the drawee bank${input.reference ? ` · ${String(input.reference).trim()}` : ""}`),
        transactionId,
        now,
      });
      await this.writeAudit(
        client,
        actor,
        returning ? "cheque.return" : "cheque.clear",
        chequeId,
        reason,
        input.idempotencyKey,
        now,
      );

      const response = {
        chequeId,
        status: outcome,
        transactionId,
        transactionRef,
        postedAt: now.toISOString(),
        /* Unchanged, and returned anyway. A screen that only hears about
           the drawer when it moves is a screen that has to remember when
           it did not — and the rule is that the client renders what the
           server sent, never what it worked out. */
        balances: await this.tillBalances(client, actor),
      };
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation=$7 AND idempotency_key=$8",
        [response, ...scope(actor), operation, input.idempotencyKey],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------
     REVERSAL — the cashing itself was a mistake

     Emphatically NOT the same path as a return, and the two must never
     share one just because both are "the cheque didn't work out".

       returned   the money is genuinely gone. The desk fronted cash, the
                  drawee bank refused, and the face amount is an EXPENSE.
                  The drawer does not move, because the cash left days
                  ago and is not coming back.

       reversed   the cashing never should have happened — wrong amount,
                  wrong customer, wrong cheque, keyed twice. The cash
                  comes BACK into the drawer, the receivable is unwound,
                  and the fee goes with it because the desk did not
                  perform a service it is entitled to charge for.

     A book that ran both through one path would either refund the fee on
     every bounced cheque (the desk quietly losing its income on exactly
     the deals that cost it money) or fail to refund it on a mis-key (the
     desk charging a customer for a transaction that did not happen).
     ------------------------------------------------------------------ */

  private async reverseCashingOnce(
    actor: LedgerActor,
    chequeId: string,
    input: ChequeReversalInput,
  ) {
    if (!input.idempotencyKey || !String(input.reason ?? "").trim())
      throw new LedgerError(
        "INVALID_REQUEST",
        "Reversal reason and idempotency key required.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "transaction:reverse");
      /* Cash goes back INTO this drawer, so this drawer has to be open.
         The clearance path deliberately does not ask for this; see the
         note there. */
      await requireOpenTill(client, actor);

      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='cheque-reverse' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), input.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'cheque-reverse',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), input.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }

      const cheque = await this.lockHeldCheque(client, actor, chequeId);
      const transactionId = String(cheque.cashing_transaction_id);
      const already = await client.query(
        "SELECT reversal_id FROM ledger_reversals WHERE transaction_id=$1 FOR UPDATE",
        [transactionId],
      );
      if (already.rowCount)
        throw new LedgerError(
          "REVERSAL_ALREADY_EXISTS",
          "This cheque cashing has already been reversed.",
        );

      const now = new Date();
      const reversalId = `rv_${randomUUID()}`;
      /* The same machinery an exchange reversal uses: the original till
         movements, inverted. Reading them back rather than recomputing
         the net from the cheque row means the cash that returns is
         exactly the cash that left, even if somebody later decides a fee
         is charged differently. */
      const movements = await client.query(
        "SELECT currency,direction,amount FROM ledger_till_movements WHERE transaction_id=$1 AND movement_kind='original' FOR UPDATE",
        [transactionId],
      );
      for (const movement of movements.rows) {
        const value = new Decimal(movement.amount);
        const direction = movement.direction === "in" ? "out" : "in";
        const delta = direction === "in" ? value : value.neg();
        const updated = await client.query(
          "UPDATE ledger_till_balances SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1>=0",
          [fixed(delta), ...scope(actor), movement.currency],
        );
        if (!updated.rowCount)
          throw new LedgerError(
            "REVERSAL_NOT_ALLOWED",
            "Till cannot support this reversal.",
          );
        await client.query(
          "INSERT INTO ledger_till_movements (transaction_id,reversal_id,movement_kind,currency,direction,amount,created_at) VALUES ($1,$2,'reversal',$3,$4,$5,$6)",
          [transactionId, reversalId, movement.currency, direction, fixed(value), now],
        );
      }
      await client.query(
        "INSERT INTO ledger_reversals (reversal_id,transaction_id,actor_id,reason,posted_at) VALUES ($1,$2,$3,$4,$5)",
        [reversalId, transactionId, actor.userId, String(input.reason).trim(), now],
      );
      /* The mirror journal, written from the original rather than
         composed again: `asset:cheques_held` credited, the drawer
         debited, and `revenue:cheque_fee` DEBITED — the fee comes off,
         which is the whole difference between this and an NSF. Deriving
         it from what was actually posted is also what makes that true
         without anybody having to remember it. */
      await client.query(
        /* `ledger_reversal_entries` carries only `amount_cad` — migration
           011's generalized `amount_home` column landed on the journal and
           not on this table. Nothing is lost: every cheque here is in the
           home currency by construction. */
        "INSERT INTO ledger_reversal_entries (reversal_id,account_code,side,amount_cad,created_at) SELECT $1,account_code,CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END,amount_cad,$2 FROM ledger_journal_entries WHERE transaction_id=$3",
        [reversalId, now, transactionId],
      );
      /* NO COST EVENT IS UNWOUND, because none was ever written. An
         exchange reversal walks `ledger_cost_events` for the transaction
         and inverts each leg; here that query would find nothing, and
         running it would only invite the reader to conclude that cheque
         cashing has a cost basis somewhere. It does not — the cash paid
         out is the home currency, whose cost is 1 by definition. */

      await client.query(
        `UPDATE ledger_cheques
            SET status='reversed', reversal_id=$1, updated_at=$2
          WHERE cheque_id=$3`,
        [reversalId, now, chequeId],
      );
      await this.writeChequeEvent(client, {
        chequeId,
        status: "reversed",
        actorId: actor.userId,
        note: `Cashing reversed — ${String(input.reason).trim()}`,
        transactionId,
        now,
      });
      await this.writeAudit(
        client,
        actor,
        "cheque.reverse",
        chequeId,
        String(input.reason).trim(),
        input.idempotencyKey,
        now,
      );

      const response = {
        chequeId,
        status: "reversed" as ChequeStatus,
        reversalId,
        transactionId,
        postedAt: now.toISOString(),
        balances: await this.tillBalances(client, actor),
      };
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='cheque-reverse' AND idempotency_key=$7",
        [response, ...scope(actor), input.idempotencyKey],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* ------------------------------------------------------------------
     shared writes
     ------------------------------------------------------------------ */

  /**
   * The cheque, locked, and only if it is still outstanding.
   *
   * Every one of the three later events acts on a cheque the desk is
   * still carrying. Clearing one twice would credit the receivable twice;
   * returning one that already cleared would book a loss on money the
   * bank has already paid; reversing a cleared cheque is a bank
   * reconciliation problem and not something a button should attempt.
   * So the status is part of the lock, not a check somewhere afterwards.
   */
  private async lockHeldCheque(
    client: pg.PoolClient,
    actor: LedgerActor,
    chequeId: string,
  ) {
    const found = await client.query(
      `SELECT * FROM ledger_cheques
        WHERE cheque_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
        FOR UPDATE`,
      [chequeId, actor.tenantId, actor.legalEntityId, actor.branchId],
    );
    if (!found.rowCount)
      throw new LedgerError("CHEQUE_NOT_FOUND", "Cheque not found at this branch.");
    const cheque = found.rows[0];
    if (cheque.status !== "held")
      throw new LedgerError(
        "CHEQUE_NOT_HELD",
        `This cheque is already ${cheque.status}. Only a cheque the desk is still carrying can be cleared, returned or reversed.`,
      );
    return cheque;
  }

  private async writeTransaction(
    client: pg.PoolClient,
    actor: LedgerActor,
    row: {
      transactionId: string;
      transactionRef: string;
      customerId: string;
      home: string;
      packId: string;
      packVersion: number;
      inputAmount: Decimal;
      outputAmount: Decimal;
      fee: Decimal;
      purpose: string;
      sourceOfFunds: string;
      dealKind: string;
      receivedInstrument: string;
      disbursedInstrument: string;
      now: Date;
    },
  ) {
    /* Both currency legs are the home currency and the rate is 1: a
       cheque in the desk's own money is not an exchange, and this row
       carries the two figures that matter — the face presented and the
       cash handed over. `spread_cad` is a hard zero because there is no
       spread; nobody was quoted a rate.

       `compliance_captured_by` is set only where a capture actually
       happened. postFrozenQuote stamps the actor unconditionally, which
       on a deal where nobody was asked anything is a claim that somebody
       was. */
    const captured = !!(row.purpose || row.sourceOfFunds);
    await client.query(
      `INSERT INTO ledger_transactions
         (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
          customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,
          fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,
          compliance_captured_by,compliance_captured_at,posted_at,
          home_currency,fee_amount,fee_currency,spread_home_amount,
          jurisdiction_pack_id,jurisdiction_pack_version,
          deal_kind,received_instrument,disbursed_instrument)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,1,
               $13,0,$14,$15,false,NULL,
               $16,$17,$18,
               $10,$13,$10,0,
               $19,$20,
               $21,$22,$23)`,
      [
        row.transactionId,
        row.transactionRef,
        ...scope(actor),
        row.customerId,
        actor.userId,
        row.home,
        fixed(row.inputAmount),
        fixed(row.outputAmount),
        fixed(row.fee),
        row.purpose,
        row.sourceOfFunds,
        captured ? actor.userId : null,
        captured ? row.now : null,
        row.now,
        row.packId,
        row.packVersion,
        row.dealKind,
        row.receivedInstrument,
        row.disbursedInstrument,
      ],
    );
  }

  private async writeChequeEvent(
    client: pg.PoolClient,
    event: {
      chequeId: string;
      status: ChequeStatus;
      actorId: string;
      note: string | null;
      transactionId: string | null;
      now: Date;
    },
  ) {
    await client.query(
      "INSERT INTO ledger_cheque_events (event_id,cheque_id,status,actor_id,note,transaction_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        `che_${randomUUID()}`,
        event.chequeId,
        event.status,
        event.actorId,
        event.note,
        event.transactionId,
        event.now,
      ],
    );
  }

  private async writeAudit(
    client: pg.PoolClient,
    actor: LedgerActor,
    action: string,
    targetId: string,
    reason: string | null,
    correlationId: string,
    now: Date,
  ) {
    await client.query(
      "INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,action,target_id,reason,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [
        randomUUID(),
        ...scope(actor).slice(0, 4),
        actor.userId,
        action,
        targetId,
        reason,
        correlationId,
        now,
      ],
    );
  }

  private async tillBalances(client: pg.PoolClient, actor: LedgerActor) {
    const rows = await client.query(
      `SELECT currency,available_amount FROM ledger_till_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
          AND workspace_id=$4 AND till_id=$5
        ORDER BY currency`,
      scope(actor),
    );
    return Object.fromEntries(
      rows.rows.map((row) => [
        String(row.currency).trim(),
        fixed(row.available_amount),
      ]),
    );
  }
}

/** Days added to a YYYY-MM-DD business date, in UTC so no timezone
    shifts the hold by one. */
function addDays(date: string, days: number) {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Debits equal credits, or nothing is written.

    Checked in code as well as being true by construction, because "it
    balances because face = net + fee" is an argument and this is a
    measurement. The three journals here are small enough that an
    unbalanced one would be a typo, and a typo in a journal is the kind of
    thing that is found six months later by an accountant. */
function assertBalanced(
  journal: readonly (readonly [string, "debit" | "credit", Decimal])[],
  message: string,
) {
  const total = (side: "debit" | "credit") =>
    journal
      .filter((line) => line[1] === side)
      .reduce((sum, line) => sum.add(line[2]), new Decimal(0));
  if (!total("debit").eq(total("credit")))
    throw new LedgerError("JOURNAL_UNBALANCED", message);
}
