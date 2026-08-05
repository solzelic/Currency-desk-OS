/* ============================================================
   The four deal types that are cash on one side and a promise on the
   other.

     remittance send      cash in,  the desk owes a payout abroad
     remittance receive   cash out, a corridor partner owes the desk
     bill payment         cash in,  the desk owes a biller
     money order          cash in,  the desk owes whoever presents it

   All four used to happen entirely in the browser. The teller took six
   hundred dollars over the counter, an array in `os-src/cdos-transfers
   .jsx` grew by one, and the ledger's drawer never heard about it. By
   the end of a day the till on the server and the till on the desk
   disagreed by whatever the shop had taken in, and the compliance
   aggregate could not see half the cash. Nothing crashed; see
   docs/CASH_OWNERSHIP_INVARIANTS.md on why that is the dangerous kind of
   defect rather than the reassuring kind.

   ---- THE ONE ACCOUNTING DECISION IN THIS FILE ----

   No margin is recognized when the deal is struck.

   A remittance desk earns in the rate as well as the fee: it sells pesos
   at its own price and buys them from a corridor partner at the
   partner's. But this product does not carry the partner's price.
   `corridors[].partners[]` holds a name, a list of payout methods and an
   ETA — see os-src/cdos-transfers.jsx — and nothing that could be called
   a cost. The only other figure available at the counter is the market
   mid, and a margin measured against the mid is a spread against a
   reference price nobody paid: exactly `revenue:fx_spread`, which
   docs/COST_BASIS.md records this codebase spending a fortnight
   removing. Reintroducing it under a new name on a new deal type would
   be the same defect wearing a hat.

   So the obligation is carried at what was ACTUALLY given up for it —
   the cash the customer handed over, or the cash the desk paid a
   beneficiary — and the margin appears when the obligation is SETTLED
   and the partner's real price is finally known. Until then the fee is
   the only thing the desk claims to have earned, which is the only thing
   it can prove it has earned. What the product would need to do better
   is named in docs/OBLIGATION_LINES.md, and it is one field.

   ---- A REVERSAL IS NOT A LOSS ----

   Three ways one of these can end, and they must never share a path:

     settle      the promise was honoured, for a real amount. Whatever
                 that amount was not, against what the book carried, is
                 margin — up or down, and a loss is a debit.
     write off   the counterparty did not perform. The desk is out the
                 money. Nothing comes back to the drawer, because nothing
                 came back.
     reverse     the deal was mis-keyed and never should have existed.
                 Cash goes back over the counter, the obligation is
                 struck out, and NOTHING touches the profit and loss.

   A mistake that looks like a loss overstates the desk's credit losses
   and understates its margin; a loss that quietly restores drawer cash
   is a drawer that does not exist. So `reverse` mirrors the movements
   and touches no revenue account, and `writeOff` touches an expense
   account and no till.
   ============================================================ */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import pg from "pg";
import { authorizeLedgerActor } from "./principal.js";
import { withSerializationRetry } from "./retry.js";
import { resolvePack } from "./jurisdiction.js";
import { resolveReportThreshold } from "./thresholds.js";
import {
  LedgerError,
  requireIdentification,
  requireOpenTill,
  type LedgerActor,
} from "./service.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];
const entityScope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
];
const fixed = (value: Decimal, places = 2) =>
  value.toDecimalPlaces(places).toFixed(places);

/* Same shape as the one in service.ts and deliberately a separate copy:
   that one is closed over an exchange's own minimum of one cent on the
   input leg, and a fee of zero is ordinary here. */
const decimal = (value: string, min: Decimal.Value, field: string) => {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new LedgerError("INVALID_REQUEST", `${field} is not a decimal amount.`);
  const out = new Decimal(value);
  if (out.lt(min) || out.gt("1000000000"))
    throw new LedgerError("INVALID_REQUEST", `${field} is outside the permitted range.`);
  return out.toDecimalPlaces(2);
};

export type ObligationKind =
  | "remittance_payable"
  | "remittance_receivable"
  | "bill_payable"
  | "money_order_payable";

/* The account each obligation stands in, and where its margin lands when
   it is finally discharged. One table rather than four branches, because
   the day a fifth line arrives the thing to get right is this map and
   not a fifth copy of the settlement journal. */
const OBLIGATION_ACCOUNTS: Record<
  ObligationKind,
  { balance: string; margin: string; loss: string; direction: "payable" | "receivable" }
> = {
  remittance_payable: {
    balance: "liability:remittance_payable",
    margin: "revenue:remittance_margin",
    loss: "expense:remittance_losses",
    direction: "payable",
  },
  remittance_receivable: {
    balance: "asset:remittance_receivable",
    margin: "revenue:remittance_margin",
    loss: "expense:remittance_losses",
    direction: "receivable",
  },
  bill_payable: {
    balance: "liability:bill_payable",
    margin: "revenue:settlement_margin",
    loss: "expense:settlement_losses",
    direction: "payable",
  },
  money_order_payable: {
    balance: "liability:money_order_payable",
    margin: "revenue:settlement_margin",
    loss: "expense:settlement_losses",
    direction: "payable",
  },
};

/* The desk's bank, which this ledger does not carry a balance for. A
   corridor partner is funded by wire and a biller is remitted by wire,
   and neither touches a drawer. Naming the account rather than leaving
   the other side of the journal implied is what keeps it balanced and
   what makes it obvious, the day a bank account IS modelled, exactly
   which line becomes a real balance. */
const BANK_CLEARING = "asset:bank_clearing";

export type ComplianceCapture = {
  purpose: string;
  sourceOfFunds: string;
  thirdParty?: boolean;
  thirdPartyName?: string | null;
};

export type RemittanceSendInput = ComplianceCapture & {
  idempotencyKey: string;
  customerId: string;
  reference: string;
  /* the cash the customer handed over for the transfer itself, in the
     desk's home currency, and the fee charged on top of it. */
  principalAmount: string;
  feeAmount: string;
  /* what the beneficiary is to be paid, and where. */
  payoutCurrency: string;
  payoutAmount: string;
  corridor: string;
  partner: string;
  beneficiaryName: string;
};

export type RemittanceReceiveInput = ComplianceCapture & {
  idempotencyKey: string;
  customerId: string;
  reference: string;
  /* what a sender abroad dispatched — the face of what the partner owes
     this desk, in the currency it was sent in. */
  sentCurrency: string;
  sentAmount: string;
  /* the cash actually counted out to the person at the counter, in the
     desk's home currency, and the fee the desk kept out of the payout
     rather than collecting separately. */
  payoutAmount: string;
  feeAmount: string;
  corridor: string;
  partner: string;
};

export type BillPaymentInput = ComplianceCapture & {
  idempotencyKey: string;
  customerId: string;
  reference: string;
  billAmount: string;
  feeAmount: string;
  biller: string;
  accountRef: string;
};

export type MoneyOrderInput = ComplianceCapture & {
  idempotencyKey: string;
  customerId: string;
  reference: string;
  faceAmount: string;
  feeAmount: string;
  payee: string;
  serial: string;
};

export type SettlementInput = {
  idempotencyKey: string;
  /* what discharging it actually cost the desk, or actually brought in,
     in the home currency. This is the number the whole design waits for. */
  amountHome: string;
  reference?: string;
  note?: string;
};

type Cash = { direction: "in" | "out"; amount: Decimal };
type JournalLine = readonly [string, "debit" | "credit", Decimal];

/* Everything a posting needs that differs between the four lines. Built
   by the four public methods and handed to one private one, so there is
   exactly one place that writes a transaction row, checks a journal
   balances and moves a drawer. */
type DealSpec = {
  dealKind: string;
  operation: string;
  receivedInstrument: string;
  disbursedInstrument: string;
  crossBorder: boolean;
  cash: Cash;
  fee: Decimal;
  /* the two currency legs as `ledger_transactions` models them. On these
     lines "from" is what the desk took and "to" is what it undertook to
     deliver, which is the same reading an exchange gets. */
  from: string;
  to: string;
  inputAmount: Decimal;
  outputAmount: Decimal;
  rate: Decimal;
  obligation: {
    kind: ObligationKind;
    counterparty: string;
    reference: string;
    corridor: string | null;
    faceCurrency: string;
    faceAmount: Decimal;
    carryingHome: Decimal;
  };
  obligationRef: string;
  capture: ComplianceCapture;
  customerId: string;
  idempotencyKey: string;
  receiptLines: (context: { ref: string; customer: string; home: string }) => string[];
};

export class ObligationService {
  constructor(private readonly pool: pg.Pool) {}

  /* ---- the four counter deals ---- */

  remittanceSend(actor: LedgerActor, input: RemittanceSendInput) {
    return withSerializationRetry(() =>
      this.postDeal(actor, (home) => {
        const principal = decimal(input.principalAmount, "0.01", "Principal");
        const fee = decimal(input.feeAmount, "0", "Fee");
        const payout = decimal(input.payoutAmount, "0.01", "Payout amount");
        return {
          dealKind: "remittance_send",
          operation: "remittance-send",
          receivedInstrument: "cash",
          disbursedInstrument: "electronic_funds_transfer",
          /* A corridor is a country, and every corridor this product
             ships crosses a border. It is recorded as a fact on the
             transaction anyway rather than inferred downstream, because
             an electronic funds transfer report has its own rules for
             cross-border movements and a report engine must not have to
             guess which of these rows crossed one. */
          crossBorder: true,
          cash: { direction: "in", amount: principal.add(fee) },
          fee,
          from: home,
          to: input.payoutCurrency,
          inputAmount: principal,
          outputAmount: payout,
          rate: payout.div(principal).toDecimalPlaces(12),
          obligation: {
            kind: "remittance_payable",
            counterparty: input.partner,
            reference: input.beneficiaryName,
            corridor: input.corridor,
            faceCurrency: input.payoutCurrency,
            faceAmount: payout,
            /* What the desk actually took for this promise. Not the
               payout translated at a mid — see the note at the head of
               this file. */
            carryingHome: principal,
          },
          obligationRef: input.reference,
          capture: input,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          receiptLines: ({ ref, customer, home: h }) => [
            "CurrencyDesk OS",
            `Receipt ${ref}`,
            `Sender: ${customer}`,
            `Transfer ${input.reference} · ${input.partner} (${input.corridor})`,
            `Beneficiary: ${input.beneficiaryName}`,
            `Paid in cash: ${h} ${fixed(principal)}`,
            `Fee paid separately: ${h} ${fixed(fee)}`,
            `Beneficiary receives: ${fixed(payout)} ${input.payoutCurrency}`,
          ],
        };
      }),
    );
  }

  remittanceReceive(actor: LedgerActor, input: RemittanceReceiveInput) {
    return withSerializationRetry(() =>
      this.postDeal(actor, (home) => {
        const sent = decimal(input.sentAmount, "0.01", "Sent amount");
        const payout = decimal(input.payoutAmount, "0.01", "Payout amount");
        const fee = decimal(input.feeAmount, "0", "Fee");
        return {
          dealKind: "remittance_receive",
          operation: "remittance-receive",
          receivedInstrument: "electronic_funds_transfer",
          disbursedInstrument: "cash",
          crossBorder: true,
          cash: { direction: "out", amount: payout },
          fee,
          from: input.sentCurrency,
          to: home,
          inputAmount: sent,
          outputAmount: payout,
          rate: payout.div(sent).toDecimalPlaces(12),
          obligation: {
            kind: "remittance_receivable",
            counterparty: input.partner,
            reference: input.reference,
            corridor: input.corridor,
            faceCurrency: input.sentCurrency,
            faceAmount: sent,
            /* The desk paid the beneficiary and kept its fee out of the
               proceeds, so what the partner owes it — on this desk's
               book — is both of those together. */
            carryingHome: payout.add(fee),
          },
          obligationRef: input.reference,
          capture: input,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          receiptLines: ({ ref, customer, home: h }) => [
            "CurrencyDesk OS",
            `Receipt ${ref}`,
            `Recipient: ${customer}`,
            `Transfer ${input.reference} · ${input.partner} (${input.corridor})`,
            `Sent: ${fixed(sent)} ${input.sentCurrency}`,
            `Fee deducted: ${h} ${fixed(fee)}`,
            `Paid out in cash: ${h} ${fixed(payout)}`,
          ],
        };
      }),
    );
  }

  billPayment(actor: LedgerActor, input: BillPaymentInput) {
    return withSerializationRetry(() =>
      this.postDeal(actor, (home) => {
        const bill = decimal(input.billAmount, "0.01", "Bill amount");
        const fee = decimal(input.feeAmount, "0", "Fee");
        return {
          dealKind: "bill_payment",
          operation: "bill-payment",
          receivedInstrument: "cash",
          disbursedInstrument: "bill_credit",
          crossBorder: false,
          cash: { direction: "in", amount: bill.add(fee) },
          fee,
          from: home,
          to: home,
          inputAmount: bill,
          outputAmount: bill,
          rate: new Decimal(1),
          obligation: {
            kind: "bill_payable",
            counterparty: input.biller,
            reference: input.accountRef,
            corridor: null,
            faceCurrency: home,
            faceAmount: bill,
            carryingHome: bill,
          },
          obligationRef: input.reference,
          capture: input,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          receiptLines: ({ ref, customer, home: h }) => [
            "CurrencyDesk OS",
            `Receipt ${ref}`,
            `Payer: ${customer}`,
            `Biller: ${input.biller} · account ${input.accountRef}`,
            `Bill paid: ${h} ${fixed(bill)}`,
            `Fee paid separately: ${h} ${fixed(fee)}`,
          ],
        };
      }),
    );
  }

  moneyOrder(actor: LedgerActor, input: MoneyOrderInput) {
    return withSerializationRetry(() =>
      this.postDeal(actor, (home) => {
        const face = decimal(input.faceAmount, "0.01", "Face amount");
        const fee = decimal(input.feeAmount, "0", "Fee");
        return {
          dealKind: "money_order",
          operation: "money-order",
          receivedInstrument: "cash",
          disbursedInstrument: "money_order",
          crossBorder: false,
          cash: { direction: "in", amount: face.add(fee) },
          fee,
          from: home,
          to: home,
          inputAmount: face,
          outputAmount: face,
          rate: new Decimal(1),
          obligation: {
            kind: "money_order_payable",
            counterparty: input.payee,
            reference: input.serial,
            corridor: null,
            faceCurrency: home,
            faceAmount: face,
            carryingHome: face,
          },
          obligationRef: input.reference,
          capture: input,
          customerId: input.customerId,
          idempotencyKey: input.idempotencyKey,
          receiptLines: ({ ref, customer, home: h }) => [
            "CurrencyDesk OS",
            `Receipt ${ref}`,
            `Purchaser: ${customer}`,
            `Money order ${input.serial} payable to ${input.payee}`,
            `Face value: ${h} ${fixed(face)}`,
            `Fee paid separately: ${h} ${fixed(fee)}`,
          ],
        };
      }),
    );
  }

  /* ---- the one posting path all four share ---- */

  private async postDeal(
    actor: LedgerActor,
    build: (home: string) => DealSpec,
  ): Promise<Record<string, unknown>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "transaction:post");
      await requireOpenTill(client, actor);
      const pack = await resolvePack(client, actor.legalEntityId);
      const home = pack.homeCurrency;
      const spec = build(home);
      if (
        (!!spec.capture.thirdParty && !spec.capture.thirdPartyName?.trim()) ||
        (!spec.capture.thirdParty && !!spec.capture.thirdPartyName?.trim())
      )
        throw new LedgerError(
          "INVALID_REQUEST",
          "Third-party status and name must be captured together.",
        );
      if (!spec.obligationRef.trim())
        throw new LedgerError("INVALID_REQUEST", "A reference is required.");
      if (!spec.obligation.counterparty.trim())
        throw new LedgerError(
          "INVALID_REQUEST",
          "The counterparty this obligation is with must be named.",
        );

      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation=$6 AND idempotency_key=$7 FOR UPDATE",
        [...scope(actor), spec.operation, spec.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [...scope(actor), spec.operation, spec.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }

      const customer = await client.query(
        "SELECT name,id_status FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 FOR UPDATE",
        [spec.customerId, ...scope(actor).slice(0, 4)],
      );
      if (!customer.rowCount)
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "Customer is not in the active workspace.",
        );

      /* ---- the two compliance gates, on the CASH ----

         The figure both are judged against is the cash that crossed the
         counter, in the currency the book is kept in. On a send that is
         the transfer plus its fee; on a receive it is what was counted
         out to the person collecting. Not the foreign leg: a remittance
         receive's `input_amount` is the sum a sender abroad dispatched,
         and judging an identification threshold against a number of
         pesos would be an accident waiting for the first Manila corridor.

         Identification is asked on cash in EITHER direction, which is
         not the same rule the REPORT follows. A large cash report is
         about cash a desk RECEIVED; knowing who you just handed four
         thousand dollars to is a separate obligation and a plainly
         sensible one. The direction is recorded on the row so the report
         engine can apply its own rule — see the columns migration 018
         adds — and the gate here does not pretend to be that engine. */
      const amountHome = spec.cash.amount;
      await requireIdentification(
        client,
        actor,
        pack,
        amountHome,
        customer.rows[0].id_status,
      );
      if (!spec.capture.purpose.trim() || !spec.capture.sourceOfFunds.trim()) {
        const reporting = await resolveReportThreshold(
          client,
          actor.legalEntityId,
          pack,
        );
        if (reporting === null || amountHome.gte(reporting))
          throw new LedgerError(
            "COMPLIANCE_BLOCKED",
            reporting === null
              ? "This desk has no reporting threshold, so a deal cannot be posted without its purpose and source of funds. Set one in Settings, or ask your jurisdiction pack to be installed."
              : "Authoritative compliance policy blocked posting.",
          );
      }

      /* Cash the desk does not have cannot be paid out, and the refusal
         happens before anything is written — the same rule and the same
         error code an exchange refuses under. The balance update below
         carries its own `>= 0` guard as well; this one exists so the
         desk is told which drawer is short rather than being told a
         movement was "rejected" after the row already read as posted. */
      if (spec.cash.direction === "out") {
        const drawer = await client.query(
          "SELECT available_amount FROM ledger_till_balances WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6 FOR UPDATE",
          [...scope(actor), home],
        );
        if (
          !drawer.rowCount ||
          new Decimal(drawer.rows[0].available_amount).lt(spec.cash.amount)
        )
          throw new LedgerError(
            "INSUFFICIENT_TILL_LIQUIDITY",
            "Insufficient till liquidity.",
          );
      }

      const accounts = OBLIGATION_ACCOUNTS[spec.obligation.kind];
      const journal: JournalLine[] =
        spec.cash.direction === "in"
          ? [
              /* Cash over the counter, against a promise and a fee. The
                 obligation is credited at what the desk took for it and
                 the fee is its own line, because a journal you cannot
                 read the two apart in is worse than no journal. */
              [`till:${home}`, "debit", spec.cash.amount],
              [accounts.balance, "credit", spec.obligation.carryingHome],
              ["revenue:fee", "credit", spec.fee],
            ]
          : [
              /* Cash out against a receivable — the same shape as a
                 cheque cashing, which is what a remittance receive
                 structurally is. The fee is retained out of the proceeds
                 rather than collected separately, so it never touches
                 the drawer and the receivable carries both halves. */
              [accounts.balance, "debit", spec.obligation.carryingHome],
              [`till:${home}`, "credit", spec.cash.amount],
              ["revenue:fee", "credit", spec.fee],
            ];

      const now = new Date();
      const transactionId = `tx_${randomUUID()}`;
      const transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;
      await this.writeTransaction(client, actor, {
        transactionId,
        transactionRef,
        now,
        customerId: spec.customerId,
        dealKind: spec.dealKind,
        receivedInstrument: spec.receivedInstrument,
        disbursedInstrument: spec.disbursedInstrument,
        crossBorder: spec.crossBorder,
        cashInHome: spec.cash.direction === "in" ? spec.cash.amount : new Decimal(0),
        cashOutHome: spec.cash.direction === "out" ? spec.cash.amount : new Decimal(0),
        from: spec.from,
        to: spec.to,
        inputAmount: spec.inputAmount,
        outputAmount: spec.outputAmount,
        rate: spec.rate,
        fee: spec.fee,
        capture: spec.capture,
        journal,
      });

      const delta =
        spec.cash.direction === "in" ? spec.cash.amount : spec.cash.amount.neg();
      const moved = await client.query(
        "UPDATE ledger_till_balances SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1>=0",
        [fixed(delta), ...scope(actor), home],
      );
      if (!moved.rowCount)
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Till movement rejected.",
        );
      await client.query(
        "INSERT INTO ledger_till_movements (transaction_id,movement_kind,currency,direction,amount,created_at) VALUES ($1,'original',$2,$3,$4,$5)",
        [transactionId, home, spec.cash.direction, fixed(spec.cash.amount), now],
      );

      const obligationId = `obl_${randomUUID()}`;
      await client.query(
        `INSERT INTO ledger_obligations
           (obligation_id,obligation_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
            customer_id,transaction_id,kind,direction,counterparty,reference,corridor,
            face_currency,face_amount,home_currency,carrying_amount_home,status,opened_at,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'open',$19,$20)`,
        [
          obligationId,
          spec.obligationRef.trim(),
          ...scope(actor),
          spec.customerId,
          transactionId,
          spec.obligation.kind,
          accounts.direction,
          spec.obligation.counterparty.trim(),
          spec.obligation.reference.trim() || null,
          spec.obligation.corridor,
          spec.obligation.faceCurrency,
          fixed(spec.obligation.faceAmount),
          home,
          fixed(spec.obligation.carryingHome),
          now,
          actor.userId,
        ],
      );
      await client.query(
        "INSERT INTO ledger_obligation_events (event_id,obligation_id,kind,transaction_id,amount_home,margin_home,reference,actor_id,created_at) VALUES ($1,$2,'opened',$3,$4,'0.00',$5,$6,$7)",
        [
          `oev_${randomUUID()}`,
          obligationId,
          transactionId,
          fixed(spec.obligation.carryingHome),
          spec.obligationRef.trim(),
          actor.userId,
          now,
        ],
      );
      await this.audit(client, actor, `${spec.dealKind}.post`, transactionId, spec.idempotencyKey, now);

      const response = {
        transactionId,
        transactionRef,
        obligationId,
        obligationRef: spec.obligationRef.trim(),
        obligationKind: spec.obligation.kind,
        obligationStatus: "open",
        postedAt: now.toISOString(),
        customerId: spec.customerId,
        dealKind: spec.dealKind,
        from: spec.from,
        to: spec.to,
        inputAmount: fixed(spec.inputAmount),
        outputAmount: fixed(spec.outputAmount),
        rate: fixed(spec.rate, 12),
        feeAmount: fixed(spec.fee),
        homeCurrency: home,
        cashDirection: spec.cash.direction,
        cashAmountHome: fixed(spec.cash.amount),
        crossBorder: spec.crossBorder,
        faceCurrency: spec.obligation.faceCurrency,
        faceAmount: fixed(spec.obligation.faceAmount),
        carryingAmountHome: fixed(spec.obligation.carryingHome),
        counterparty: spec.obligation.counterparty.trim(),
        receipt: {
          receiptId: `rcpt_${transactionId}`,
          lines: spec.receiptLines({
            ref: transactionRef,
            customer: customer.rows[0].name,
            home,
          }),
        },
      };
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation=$7 AND idempotency_key=$8",
        [response, ...scope(actor), spec.operation, spec.idempotencyKey],
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

  /* ---- the promise was honoured ----

     And here, finally, is the margin. Whatever the obligation was
     carried at, less what discharging it actually cost, is what the desk
     made on the rate — measured against a price it really paid rather
     than against a mid nobody traded at. On a receivable the sign is the
     other way round: less back than the book claimed is a shortfall, and
     it is a debit.

     Requires `transaction:reverse` rather than `transaction:post`. This
     is not a counter act — it changes the profit reported on a deal that
     already happened, off the back of a partner statement nobody at the
     counter can see — and the roles that carry that permission are
     exactly the ones a desk lets near a restatement. */
  settle(actor: LedgerActor, obligationId: string, input: SettlementInput) {
    return withSerializationRetry(() => this.closeOnce(actor, obligationId, input, "settled"));
  }

  /* ---- the counterparty did not perform ----

     A partner that failed to pay is a LOSS, and it is booked as one: the
     receivable comes off the book against an expense account and not one
     cent goes back into the drawer, because not one cent came back.

     Payables are refused. A money order nobody presents does not become
     the desk's money — in most jurisdictions it escheats to the state
     after a stated period — and this ledger's packs say nothing about
     dormancy or escheatment. Writing one off would be the software
     inventing a rule about somebody else's money, which is the failure
     mode `012_jurisdiction_reports.sql` is written against. Named as a
     missing field in docs/OBLIGATION_LINES.md rather than guessed at. */
  writeOff(
    actor: LedgerActor,
    obligationId: string,
    input: { idempotencyKey: string; reason: string },
  ) {
    return withSerializationRetry(() =>
      this.closeOnce(
        actor,
        obligationId,
        { idempotencyKey: input.idempotencyKey, amountHome: "0", note: input.reason },
        "written_off",
      ),
    );
  }

  private async closeOnce(
    actor: LedgerActor,
    obligationId: string,
    input: SettlementInput,
    ending: "settled" | "written_off",
  ): Promise<Record<string, unknown>> {
    if (!input.idempotencyKey?.trim())
      throw new LedgerError("INVALID_REQUEST", "An idempotency key is required.");
    if (ending === "written_off" && !input.note?.trim())
      throw new LedgerError(
        "INVALID_REQUEST",
        "A write-off has to say why the money was lost.",
      );
    const operation = ending === "settled" ? "obligation-settle" : "obligation-write-off";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "transaction:reverse");
      const replay = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation=$6 AND idempotency_key=$7 FOR UPDATE",
        [...scope(actor), operation, input.idempotencyKey],
      );
      if (replay.rowCount && replay.rows[0].response) {
        await client.query("COMMIT");
        return replay.rows[0].response;
      }
      if (!replay.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [...scope(actor), operation, input.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError("IDEMPOTENCY_IN_PROGRESS", "Request is already in progress.");
      }
      const found = await client.query(
        `SELECT * FROM ledger_obligations
          WHERE obligation_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4
          FOR UPDATE`,
        [obligationId, ...entityScope(actor)],
      );
      if (!found.rowCount)
        throw new LedgerError("OBLIGATION_NOT_FOUND", "That obligation is not on this desk's book.");
      const obligation = found.rows[0];
      if (obligation.status !== "open")
        throw new LedgerError(
          "OBLIGATION_NOT_OPEN",
          `This obligation is already ${obligation.status}.`,
        );
      const accounts = OBLIGATION_ACCOUNTS[obligation.kind as ObligationKind];
      if (ending === "written_off" && accounts.direction === "payable")
        throw new LedgerError(
          "OBLIGATION_NOT_WRITABLE_OFF",
          "A payable the desk still owes cannot be written off. An instrument nobody presents does not become the desk's money — what happens to it is a dormancy rule, and no jurisdiction pack here states one.",
        );

      const carrying = new Decimal(obligation.carrying_amount_home);
      const amount =
        ending === "settled"
          ? decimal(input.amountHome, "0", "Settlement amount")
          : new Decimal(0);
      /* Positive is a gain to the desk, whichever side the obligation sat
         on. A payable discharged for less than it was carried at is the
         rate margin the counter deliberately did not claim; a receivable
         that came back short is a loss. */
      const margin =
        accounts.direction === "payable" ? carrying.sub(amount) : amount.sub(carrying);
      const home = obligation.home_currency as string;

      const journal: JournalLine[] =
        accounts.direction === "payable"
          ? [
              [accounts.balance, "debit", carrying],
              [BANK_CLEARING, "credit", amount],
              [accounts.margin, margin.gte(0) ? "credit" : "debit", margin.abs()],
            ]
          : ending === "settled"
            ? [
                [BANK_CLEARING, "debit", amount],
                [accounts.margin, margin.gte(0) ? "credit" : "debit", margin.abs()],
                [accounts.balance, "credit", carrying],
              ]
            : [
                /* Nothing arrived. The whole carrying amount is the loss,
                   and it goes to an expense account rather than to the
                   margin account a settlement uses — a corridor that
                   defaulted is not a corridor that priced badly, and a
                   desk reading its margin line should not have to
                   subtract its own bad debts out of it by hand. */
                [accounts.loss, "debit", carrying],
                [accounts.balance, "credit", carrying],
              ];

      const now = new Date();
      const transactionId = `tx_${randomUUID()}`;
      const transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;
      const settling = ending === "settled";
      await this.writeTransaction(client, actor, {
        transactionId,
        transactionRef,
        now,
        customerId: obligation.customer_id,
        dealKind: settling ? "obligation_settlement" : "obligation_write_off",
        /* No cash and no counter. Money moves between the desk and its
           bank on a settlement, and on a write-off nothing moves at
           all — the desk simply stops claiming an asset it has. */
        receivedInstrument:
          settling && accounts.direction === "receivable" ? "bank_credit" : "none",
        disbursedInstrument:
          settling && accounts.direction === "payable" ? "bank_credit" : "none",
        crossBorder: obligation.corridor !== null,
        cashInHome: new Decimal(0),
        cashOutHome: new Decimal(0),
        from: home,
        to: home,
        inputAmount: carrying,
        outputAmount: amount,
        rate: new Decimal(1),
        fee: new Decimal(0),
        capture: {
          purpose: settling ? "Obligation settlement" : "Obligation write-off",
          sourceOfFunds: settling ? `Settled with ${obligation.counterparty}` : (input.note ?? ""),
        },
        journal,
      });

      await client.query(
        `UPDATE ledger_obligations
            SET status=$1, settled_amount_home=$2, settled_at=$3,
                settlement_transaction_id=$4, updated_at=$3
          WHERE obligation_id=$5`,
        [ending, settling ? fixed(amount) : null, now, transactionId, obligationId],
      );
      await client.query(
        "INSERT INTO ledger_obligation_events (event_id,obligation_id,kind,transaction_id,amount_home,margin_home,reference,reason,actor_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          `oev_${randomUUID()}`,
          obligationId,
          ending,
          transactionId,
          fixed(amount),
          fixed(margin),
          input.reference?.trim() || null,
          input.note?.trim() || null,
          actor.userId,
          now,
        ],
      );
      await this.audit(
        client,
        actor,
        settling ? "obligation.settle" : "obligation.write_off",
        obligationId,
        input.idempotencyKey,
        now,
        input.note?.trim() || null,
      );

      const response = {
        obligationId,
        obligationRef: obligation.obligation_ref,
        status: ending,
        transactionId,
        transactionRef,
        postedAt: now.toISOString(),
        carryingAmountHome: fixed(carrying),
        settledAmountHome: settling ? fixed(amount) : null,
        /* Signed, and named for what it is. A reader who sees a negative
           here is looking at a corridor that cost more than it was sold
           for, which is a real and reportable thing for a desk to have
           done. */
        marginHome: fixed(margin),
        homeCurrency: home,
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

  /* ---- the deal never should have existed ----

     Distinct from every path above, and it has to be. Cash goes back
     over the counter exactly as it came, the obligation is struck out,
     the journal is mirrored into `ledger_reversal_entries`, and no
     revenue, margin or expense account is touched by anything other than
     that mirror. A mis-keyed remittance must not appear anywhere in the
     desk's corridor losses.

     Refused once the obligation has been discharged. A settled promise
     cannot be un-made by saying the deal never happened — the partner
     has been paid, or has paid — and the honest move at that point is a
     new deal in the other direction, not a rewrite of history. */
  reverse(actor: LedgerActor, transactionId: string, idempotencyKey: string, reason: string) {
    return withSerializationRetry(() =>
      this.reverseOnce(actor, transactionId, idempotencyKey, reason),
    );
  }

  private async reverseOnce(
    actor: LedgerActor,
    transactionId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<Record<string, unknown>> {
    if (!idempotencyKey?.trim() || !reason.trim())
      throw new LedgerError(
        "INVALID_REQUEST",
        "Reversal reason and idempotency key required.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await authorizeLedgerActor(client, actor, "transaction:reverse");
      const replay = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='obligation-reverse' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), idempotencyKey],
      );
      if (replay.rowCount && replay.rows[0].response) {
        await client.query("COMMIT");
        return replay.rows[0].response;
      }
      if (!replay.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'obligation-reverse',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError("IDEMPOTENCY_IN_PROGRESS", "Request is already in progress.");
      }
      const found = await client.query(
        `SELECT o.*, t.deal_kind
           FROM ledger_obligations o
           JOIN ledger_transactions t ON t.transaction_id = o.transaction_id
          WHERE o.transaction_id=$1 AND o.tenant_id=$2 AND o.legal_entity_id=$3
            AND o.branch_id=$4 AND o.workspace_id=$5 AND o.till_id=$6
          FOR UPDATE OF o`,
        [transactionId, ...scope(actor)],
      );
      if (!found.rowCount)
        throw new LedgerError(
          "TRANSACTION_NOT_FOUND",
          "No obligation deal with that transaction is on this till's book.",
        );
      const obligation = found.rows[0];
      if (obligation.status !== "open")
        throw new LedgerError(
          "REVERSAL_NOT_ALLOWED",
          `This deal's obligation is already ${obligation.status}. A discharged promise is undone by a new deal, not by saying the first one never happened.`,
        );
      const already = await client.query(
        "SELECT reversal_id FROM ledger_reversals WHERE transaction_id=$1 FOR UPDATE",
        [transactionId],
      );
      if (already.rowCount)
        throw new LedgerError("REVERSAL_ALREADY_EXISTS", "Transaction already reversed.");

      const reversalId = `rv_${randomUUID()}`;
      const now = new Date();
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
        [reversalId, transactionId, actor.userId, reason.trim(), now],
      );
      await client.query(
        "INSERT INTO ledger_reversal_entries (reversal_id,account_code,side,amount_cad,created_at) SELECT $1,account_code,CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END,amount_cad,$2 FROM ledger_journal_entries WHERE transaction_id=$3",
        [reversalId, now, transactionId],
      );
      await client.query(
        "UPDATE ledger_obligations SET status='reversed', reversal_id=$1, updated_at=$2 WHERE obligation_id=$3",
        [reversalId, now, obligation.obligation_id],
      );
      await client.query(
        "INSERT INTO ledger_obligation_events (event_id,obligation_id,kind,amount_home,margin_home,reason,actor_id,created_at) VALUES ($1,$2,'reversed','0.00','0.00',$3,$4,$5)",
        [`oev_${randomUUID()}`, obligation.obligation_id, reason.trim(), actor.userId, now],
      );
      await this.audit(
        client,
        actor,
        "obligation.reverse",
        transactionId,
        idempotencyKey,
        now,
        reason.trim(),
      );
      const response = {
        reversalId,
        transactionId,
        obligationId: obligation.obligation_id,
        obligationStatus: "reversed",
        postedAt: now.toISOString(),
      };
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='obligation-reverse' AND idempotency_key=$7",
        [response, ...scope(actor), idempotencyKey],
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

  /* ---- what the desk owes and is owed, right now ----

     Scoped to the legal entity rather than the till, because an
     obligation is the desk's, not the drawer's: the teller who took the
     remittance goes home and the payout still has to be funded. */
  async list(actor: LedgerActor, options: { status?: string; limit: number }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await authorizeLedgerActor(client, actor, "ledger:view");
      const rows = await client.query(
        `SELECT o.*, t.posted_at, t.transaction_ref, c.name AS customer_name
           FROM ledger_obligations o
           JOIN ledger_transactions t ON t.transaction_id = o.transaction_id
           LEFT JOIN ledger_customers c ON c.customer_id = o.customer_id
          WHERE o.tenant_id=$1 AND o.legal_entity_id=$2 AND o.branch_id=$3
            AND ($4::text IS NULL OR o.status=$4)
          ORDER BY o.opened_at DESC
          LIMIT $5`,
        [...entityScope(actor), options.status ?? null, options.limit],
      );
      /* Open exposure per side, in the home currency. The reason this
         table exists: a desk with forty open remittances has forty
         payouts to fund, and it should be able to read that as one
         number rather than counting rows in a browser store. */
      const outstanding = await client.query(
        `SELECT direction, sum(carrying_amount_home) AS total, count(*) AS count
           FROM ledger_obligations
          WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND status='open'
          GROUP BY direction`,
        entityScope(actor),
      );
      await client.query("COMMIT");
      const totals = { payable: null as string | null, receivable: null as string | null };
      for (const row of outstanding.rows)
        totals[row.direction as "payable" | "receivable"] = new Decimal(row.total).toFixed(2);
      return {
        obligations: rows.rows.map((row) => ({
          obligationId: row.obligation_id,
          obligationRef: row.obligation_ref,
          transactionId: row.transaction_id,
          transactionRef: row.transaction_ref,
          customerId: row.customer_id,
          customerName: row.customer_name ?? null,
          kind: row.kind,
          direction: row.direction,
          counterparty: row.counterparty,
          reference: row.reference,
          corridor: row.corridor,
          faceCurrency: row.face_currency,
          faceAmount: row.face_amount,
          homeCurrency: row.home_currency,
          carryingAmountHome: row.carrying_amount_home,
          status: row.status,
          settledAmountHome: row.settled_amount_home,
          settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
          openedAt: new Date(row.opened_at).toISOString(),
        })),
        /* Null, not zero, where the desk has nothing open on a side —
           the same rule every other read on this ledger follows. A desk
           that has never taken a remittance has no payable position, and
           "0.00" is a claim about a book nobody has written in. */
        outstanding: totals,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /* ---- one place writes a transaction row and its journal ---- */

  private async writeTransaction(
    client: pg.PoolClient,
    actor: LedgerActor,
    row: {
      transactionId: string;
      transactionRef: string;
      now: Date;
      customerId: string;
      dealKind: string;
      receivedInstrument: string;
      disbursedInstrument: string;
      crossBorder: boolean;
      cashInHome: Decimal;
      cashOutHome: Decimal;
      from: string;
      to: string;
      inputAmount: Decimal;
      outputAmount: Decimal;
      rate: Decimal;
      fee: Decimal;
      capture: ComplianceCapture;
      journal: JournalLine[];
    },
  ) {
    /* The check the whole file exists to pass, and it is not routed
       around anywhere: if the two sides do not agree the transaction
       rolls back and nothing at all is written. */
    const debits = row.journal
      .filter((line) => line[1] === "debit")
      .reduce((sum, line) => sum.add(line[2]), new Decimal(0));
    const credits = row.journal
      .filter((line) => line[1] === "credit")
      .reduce((sum, line) => sum.add(line[2]), new Decimal(0));
    if (!debits.eq(credits))
      throw new LedgerError("JOURNAL_UNBALANCED", "Obligation journal is unbalanced.");

    await client.query(
      `INSERT INTO ledger_transactions
         (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
          customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,
          fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,
          compliance_captured_by,compliance_captured_at,posted_at,
          deal_kind,received_instrument,disbursed_instrument,cross_border,cash_in_home,cash_out_home)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22,$23,$24,$25,$26,$27,$28)`,
      [
        row.transactionId,
        row.transactionRef,
        ...scope(actor),
        row.customerId,
        actor.userId,
        row.from,
        row.to,
        fixed(row.inputAmount),
        fixed(row.outputAmount),
        fixed(row.rate, 12),
        fixed(row.fee),
        /* Zero, and meant: the desk claimed no spread at the counter on
           any of these lines. The margin, where there is one, is
           recognized at settlement against a price that was really paid.
           Leaving this column to carry an estimate is the whole thing
           docs/COST_BASIS.md is about. */
        "0.00",
        row.capture.purpose.trim(),
        row.capture.sourceOfFunds.trim(),
        !!row.capture.thirdParty,
        row.capture.thirdParty ? (row.capture.thirdPartyName?.trim() || null) : null,
        actor.userId,
        row.now,
        row.dealKind,
        row.receivedInstrument,
        row.disbursedInstrument,
        row.crossBorder,
        fixed(row.cashInHome),
        fixed(row.cashOutHome),
      ],
    );
    for (const [account, side, value] of row.journal) {
      /* A journal line for nothing is noise, and a fee of zero is
         ordinary on these lines. The sides were totalled above, so
         dropping the zeroes cannot unbalance anything. */
      if (value.isZero()) continue;
      await client.query(
        "INSERT INTO ledger_journal_entries (transaction_id,account_code,side,amount_cad,created_at) VALUES ($1,$2,$3,$4,$5)",
        [row.transactionId, account, side, fixed(value), row.now],
      );
    }
  }

  private async audit(
    client: pg.PoolClient,
    actor: LedgerActor,
    action: string,
    targetId: string,
    correlationId: string,
    now: Date,
    reason: string | null = null,
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
}
