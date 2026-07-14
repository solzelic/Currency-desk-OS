import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import pg from "pg";
import {
  hasBackendPermission,
  type BackendPermission,
} from "../auth/permissions.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Currency = "CAD" | "USD" | "EUR" | "GBP";
export type LedgerActor = {
  userId: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  workspaceId: string;
  tillId: string;
  role: string;
  authorizedBranchIds: string[];
};
export type PostRequest = {
  idempotencyKey: string;
  customerId: string;
  from: Currency;
  to: Currency;
  inputAmount: string;
  feeCad: string;
  purpose: string;
  sourceOfFunds: string;
};
export type FrozenQuote = {
  quoteId: string;
  customerId: string;
  from: Currency;
  to: Currency;
  inputAmount: string;
  outputAmount: string;
  marketMid: string;
  customerRate: string;
  feeCad: string;
  spreadCad: string;
  rateBoardPublicationId: string;
  marketSnapshotId: string | null;
};
export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];
const decimal = (value: string, min: Decimal.Value) => {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new LedgerError("INVALID_REQUEST", "Invalid decimal amount.");
  const out = new Decimal(value);
  if (out.lt(min) || out.gt("1000000000"))
    throw new LedgerError(
      "INVALID_REQUEST",
      "Amount outside the permitted range.",
    );
  return out.toDecimalPlaces(2);
};
const fixed = (value: Decimal, places = 2) =>
  value.toDecimalPlaces(places).toFixed(places);

export class LedgerService {
  constructor(private readonly pool: pg.Pool) {}

  private async principal(
    client: pg.PoolClient,
    actor: LedgerActor,
    permission: BackendPermission,
  ) {
    const found = await client.query(
      "SELECT role, authorized_branch_ids FROM ledger_principals WHERE user_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE",
      [actor.userId, ...scope(actor)],
    );
    if (!found.rowCount)
      throw new LedgerError(
        "SCOPE_DENIED",
        "Authenticated principal is outside this workspace.",
      );
    const principal = found.rows[0];
    if (
      !hasBackendPermission(principal.role, permission) ||
      !principal.authorized_branch_ids.includes(actor.branchId)
    )
      throw new LedgerError("AUTHORIZATION_DENIED", `Missing ${permission}.`);
  }

  async postFrozenQuote(
    actor: LedgerActor,
    quote: FrozenQuote,
    idempotencyKey: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:post");
      const authoritativeQuote = await client.query(
        "SELECT * FROM quotes WHERE quote_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE",
        [quote.quoteId, ...scope(actor)],
      );
      if (!authoritativeQuote.rowCount)
        throw new LedgerError(
          "SCOPE_DENIED",
          "Quote is outside the active scope.",
        );
      const row = authoritativeQuote.rows[0];
      if (row.status !== "active")
        throw new LedgerError("QUOTE_NOT_ACTIVE", "Quote cannot be posted.");
      if (new Date(row.expires_at).getTime() <= Date.now())
        throw new LedgerError("QUOTE_EXPIRED", "Quote has expired.");
      const override = await client.query(
        "SELECT overridden_customer_rate,overridden_output_amount,overridden_spread_cad FROM quote_overrides WHERE quote_id=$1 ORDER BY created_at DESC LIMIT 1",
        [quote.quoteId],
      );
      const expectedRate =
        override.rows[0]?.overridden_customer_rate ?? row.customer_rate;
      const expectedOutput =
        override.rows[0]?.overridden_output_amount ?? row.output_amount;
      const expectedSpread =
        override.rows[0]?.overridden_spread_cad ?? row.spread_cad;
      const sameDecimal = (left: string, right: string, places: number) =>
        new Decimal(left).toDecimalPlaces(places).eq(new Decimal(right).toDecimalPlaces(places));
      if (
        quote.quoteId !== row.quote_id ||
        row.customer_id !== quote.customerId ||
        row.from_currency !== quote.from || row.to_currency !== quote.to ||
        !sameDecimal(row.input_amount, quote.inputAmount, 2) ||
        !sameDecimal(expectedOutput, quote.outputAmount, 2) ||
        !sameDecimal(row.market_mid, quote.marketMid, 12) ||
        !sameDecimal(expectedRate, quote.customerRate, 12) ||
        !sameDecimal(row.fee_cad, quote.feeCad, 2) ||
        !sameDecimal(expectedSpread, quote.spreadCad, 2) ||
        row.rate_board_publication_id !== quote.rateBoardPublicationId ||
        (row.market_snapshot_id ?? null) !== (quote.marketSnapshotId ?? null)
      )
        throw new LedgerError(
          "QUOTE_MISMATCH",
          "Frozen quote terms do not match authoritative record.",
        );
      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='quote-post' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'quote-post',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }
      const customer = await client.query(
        "SELECT name,id_status FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 FOR UPDATE",
        [quote.customerId, ...scope(actor).slice(0, 4)],
      );
      if (!customer.rowCount)
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "Customer is not in the active workspace.",
        );
      const input = decimal(quote.inputAmount, "0.01"),
        output = decimal(quote.outputAmount, "0"),
        fee = decimal(quote.feeCad, "0"),
        mid = new Decimal(quote.marketMid),
        rate = new Decimal(quote.customerRate),
        spread = decimal(quote.spreadCad, "0");
      const inputCad =
        quote.from === "CAD" ? input : input.mul(mid).toDecimalPlaces(2);
      const outputCad =
        quote.to === "CAD" ? output : output.mul(mid).toDecimalPlaces(2);
      if (inputCad.gte(3000) && customer.rows[0].id_status !== "verified")
        throw new LedgerError(
          "COMPLIANCE_BLOCKED",
          "Authoritative compliance policy blocked posting.",
        );
      const destination = await client.query(
        "SELECT available_amount FROM ledger_till_balances WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6 FOR UPDATE",
        [...scope(actor), quote.to],
      );
      if (
        !destination.rowCount ||
        new Decimal(destination.rows[0].available_amount).lt(output)
      )
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Insufficient till liquidity.",
        );
      const journal = [
        [`till:${quote.from}`, "debit", inputCad.add(fee)],
        [`till:${quote.to}`, "credit", outputCad],
        ["revenue:fx_spread", "credit", spread],
        ["revenue:fee", "credit", fee],
      ] as const;
      const debits = journal
        .filter((x) => x[1] === "debit")
        .reduce((s, x) => s.add(x[2]), new Decimal(0));
      const credits = journal
        .filter((x) => x[1] === "credit")
        .reduce((s, x) => s.add(x[2]), new Decimal(0));
      if (!debits.eq(credits))
        throw new LedgerError(
          "JOURNAL_UNBALANCED",
          "Frozen quote journal is unbalanced.",
        );
      const now = new Date(),
        transactionId = `tx_${randomUUID()}`,
        transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;
      const response = {
        transactionId,
        transactionRef,
        postedAt: now.toISOString(),
        quoteId: quote.quoteId,
        customerId: quote.customerId,
        from: quote.from,
        to: quote.to,
        inputAmount: fixed(input),
        outputAmount: fixed(output),
        rate: fixed(rate, 12),
        marketMid: fixed(mid, 12),
        feeCad: fixed(fee),
        spreadCad: fixed(spread),
        rateBoardPublicationId: quote.rateBoardPublicationId,
        marketSnapshotId: quote.marketSnapshotId,
        receipt: {
          receiptId: `rcpt_${transactionId}`,
          lines: [
            "CurrencyDesk OS",
            `Receipt ${transactionRef}`,
            `Customer: ${customer.rows[0].name}`,
            `Quote: ${quote.quoteId}`,
            `Paid exchange: ${fixed(input)} ${quote.from}`,
            `Fee paid separately: CAD ${fixed(fee)}`,
            `Received: ${fixed(output)} ${quote.to}`,
          ],
        },
      };
      await client.query(
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
        [
          transactionId,
          transactionRef,
          ...scope(actor),
          quote.customerId,
          actor.userId,
          quote.from,
          quote.to,
          fixed(input),
          fixed(output),
          fixed(rate, 12),
          fixed(fee),
          fixed(spread),
          `Quote ${quote.quoteId}`,
          "Quote service",
          now,
        ],
      );
      for (const [account, side, value] of journal)
        await client.query(
          "INSERT INTO ledger_journal_entries (transaction_id,account_code,side,amount_cad,created_at) VALUES ($1,$2,$3,$4,$5)",
          [transactionId, account, side, fixed(value), now],
        );
      for (const [currency, direction, value] of [
        [quote.from, "in", input],
        [quote.to, "out", output],
        ["CAD", "in", fee],
      ] as const) {
        if (value.isZero()) continue;
        const delta = direction === "in" ? value : value.neg();
        const updated = await client.query(
          "UPDATE ledger_till_balances SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1>=0",
          [fixed(delta), ...scope(actor), currency],
        );
        if (!updated.rowCount)
          throw new LedgerError(
            "INSUFFICIENT_TILL_LIQUIDITY",
            "Till movement rejected.",
          );
        await client.query(
          "INSERT INTO ledger_till_movements (transaction_id,movement_kind,currency,direction,amount,created_at) VALUES ($1,'original',$2,$3,$4,$5)",
          [transactionId, currency, direction, fixed(value), now],
        );
      }
      await client.query(
        "INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,action,target_id,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,'transaction.post',$7,$8,$9)",
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          transactionId,
          idempotencyKey,
          now,
        ],
      );
      await client.query(
        "UPDATE quotes SET status='posted',posted_transaction_id=$1 WHERE quote_id=$2",
        [transactionId, quote.quoteId],
      );
      await client.query(
        "INSERT INTO quote_events (event_id,quote_id,actor_id,event_type,detail,created_at) VALUES ($1,$2,$3,'posted',$4,$5)",
        [
          randomUUID(),
          quote.quoteId,
          actor.userId,
          JSON.stringify({ transactionId }),
          now,
        ],
      );
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='quote-post' AND idempotency_key=$7",
        [response, ...scope(actor), idempotencyKey],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "40001") {
        throw new LedgerError("IDEMPOTENCY_IN_PROGRESS", "Retry the idempotent request.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async post(actor: LedgerActor, request: PostRequest) {
    if (!request.idempotencyKey || request.from === request.to)
      throw new LedgerError(
        "INVALID_REQUEST",
        "Idempotency key and distinct currencies are required.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:post");
      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='post' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), request.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        return existing.rows[0].response;
      }
      if (!existing.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'post',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), request.idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }
      const customer = await client.query(
        "SELECT name,id_status FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 FOR UPDATE",
        [request.customerId, ...scope(actor).slice(0, 4)],
      );
      if (!customer.rowCount)
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "Customer is not in the active workspace.",
        );
      const rows = await client.query(
        "SELECT currency,units_per_cad FROM ledger_rates WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4",
        scope(actor).slice(0, 4),
      );
      const rates = Object.fromEntries(
        rows.rows.map((row) => [row.currency, new Decimal(row.units_per_cad)]),
      ) as Record<Currency, Decimal>;
      if (!rates[request.from] || !rates[request.to])
        throw new LedgerError("RATE_NOT_AVAILABLE", "Scoped rate missing.");
      const input = decimal(request.inputAmount, "0.01");
      const fee = decimal(request.feeCad, "0");
      const rate = rates[request.to]
        .div(rates[request.from])
        .toDecimalPlaces(12);
      // Legacy direct posting has no commercial adjustment. Quote posting
      // supplies frozen customer rate and spread through postFrozenQuote.
      const inputCad = input.div(rates[request.from]).toDecimalPlaces(2);
      const output = input.mul(rate).toDecimalPlaces(2);
      const outputCad = output.div(rates[request.to]).toDecimalPlaces(2);
      const spread = inputCad.sub(outputCad).toDecimalPlaces(2);
      if (
        (inputCad.gte(3000) && customer.rows[0].id_status !== "verified") ||
        (inputCad.gte(10000) &&
          (!request.purpose.trim() || !request.sourceOfFunds.trim()))
      )
        throw new LedgerError(
          "COMPLIANCE_BLOCKED",
          "Authoritative compliance policy blocked posting.",
        );
      const destination = await client.query(
        "SELECT available_amount FROM ledger_till_balances WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND currency=$6 FOR UPDATE",
        [...scope(actor), request.to],
      );
      if (
        !destination.rowCount ||
        new Decimal(destination.rows[0].available_amount).lt(output)
      )
        throw new LedgerError(
          "INSUFFICIENT_TILL_LIQUIDITY",
          "Insufficient till liquidity.",
        );
      // Product rule: feeCad is a separate CAD cash payment, never part of inputAmount.
      const journal = [
        [`till:${request.from}`, "debit", inputCad.add(fee)],
        [`till:${request.to}`, "credit", outputCad],
        ["revenue:fx_spread", "credit", spread],
        ["revenue:fee", "credit", fee],
      ] as const;
      const debits = journal
        .filter((line) => line[1] === "debit")
        .reduce((sum, line) => sum.add(line[2]), new Decimal(0));
      const credits = journal
        .filter((line) => line[1] === "credit")
        .reduce((sum, line) => sum.add(line[2]), new Decimal(0));
      if (!debits.eq(credits))
        throw new LedgerError(
          "JOURNAL_UNBALANCED",
          "Authoritative journal is unbalanced.",
        );
      const now = new Date();
      const transactionId = `tx_${randomUUID()}`;
      const transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;
      const response = {
        transactionId,
        transactionRef,
        postedAt: now.toISOString(),
        customerId: request.customerId,
        from: request.from,
        to: request.to,
        inputAmount: fixed(input),
        outputAmount: fixed(output),
        rate: fixed(rate, 12),
        feeCad: fixed(fee),
        feeCurrency: "CAD",
        spreadCad: fixed(spread),
        receipt: {
          receiptId: `rcpt_${transactionId}`,
          lines: [
            "CurrencyDesk OS",
            `Receipt ${transactionRef}`,
            `Customer: ${customer.rows[0].name}`,
            `Paid exchange: ${fixed(input)} ${request.from}`,
            `Fee paid separately: CAD ${fixed(fee)}`,
            `Received: ${fixed(output)} ${request.to}`,
          ],
        },
      };
      await client.query(
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,posted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
        [
          transactionId,
          transactionRef,
          ...scope(actor),
          request.customerId,
          actor.userId,
          request.from,
          request.to,
          fixed(input),
          fixed(output),
          fixed(rate, 12),
          fixed(fee),
          fixed(spread),
          request.purpose,
          request.sourceOfFunds,
          now,
        ],
      );
      for (const [account, side, value] of journal)
        await client.query(
          "INSERT INTO ledger_journal_entries (transaction_id,account_code,side,amount_cad,created_at) VALUES ($1,$2,$3,$4,$5)",
          [transactionId, account, side, fixed(value), now],
        );
      for (const [currency, direction, value] of [
        [request.from, "in", input],
        [request.to, "out", output],
        ["CAD", "in", fee],
      ] as const) {
        if (value.isZero()) continue;
        const delta = direction === "in" ? value : value.neg();
        const updated = await client.query(
          "UPDATE ledger_till_balances SET available_amount=available_amount+$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND currency=$7 AND available_amount+$1>=0",
          [fixed(delta), ...scope(actor), currency],
        );
        if (!updated.rowCount)
          throw new LedgerError(
            "INSUFFICIENT_TILL_LIQUIDITY",
            "Till movement rejected.",
          );
        await client.query(
          "INSERT INTO ledger_till_movements (transaction_id,movement_kind,currency,direction,amount,created_at) VALUES ($1,'original',$2,$3,$4,$5)",
          [transactionId, currency, direction, fixed(value), now],
        );
      }
      await client.query(
        "INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,action,target_id,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,'transaction.post',$7,$8,$9)",
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          transactionId,
          request.idempotencyKey,
          now,
        ],
      );
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='post' AND idempotency_key=$7",
        [response, ...scope(actor), request.idempotencyKey],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "40001") {
        const replay = await this.pool.query(
          "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='post' AND idempotency_key=$6",
          [...scope(actor), request.idempotencyKey],
        );
        if (replay.rowCount && replay.rows[0].response)
          return replay.rows[0].response;
        throw new LedgerError(
          "IDEMPOTENCY_IN_PROGRESS",
          "Retry the idempotent request.",
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async reverse(
    actor: LedgerActor,
    transactionId: string,
    idempotencyKey: string,
    reason: string,
  ) {
    if (!idempotencyKey || !reason.trim())
      throw new LedgerError(
        "INVALID_REQUEST",
        "Reversal reason and idempotency key required.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:reverse");
      const replay = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='reverse' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), idempotencyKey],
      );
      if (replay.rowCount && replay.rows[0].response) {
        await client.query("COMMIT");
        return replay.rows[0].response;
      }
      if (!replay.rowCount) {
        const claimed = await client.query(
          "INSERT INTO ledger_idempotency (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,operation,idempotency_key) VALUES ($1,$2,$3,$4,$5,'reverse',$6) ON CONFLICT DO NOTHING",
          [...scope(actor), idempotencyKey],
        );
        if (!claimed.rowCount)
          throw new LedgerError(
            "IDEMPOTENCY_IN_PROGRESS",
            "Request is already in progress.",
          );
      }
      const transaction = await client.query(
        "SELECT 1 FROM ledger_transactions WHERE transaction_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE",
        [transactionId, ...scope(actor)],
      );
      if (!transaction.rowCount)
        throw new LedgerError(
          "TRANSACTION_NOT_FOUND",
          "Transaction not found.",
        );
      const existing = await client.query(
        "SELECT reversal_id FROM ledger_reversals WHERE transaction_id=$1 FOR UPDATE",
        [transactionId],
      );
      if (existing.rowCount)
        throw new LedgerError(
          "REVERSAL_ALREADY_EXISTS",
          "Transaction already reversed.",
        );
      const movements = await client.query(
        "SELECT currency,direction,amount FROM ledger_till_movements WHERE transaction_id=$1 AND movement_kind='original' FOR UPDATE",
        [transactionId],
      );
      const reversalId = `rv_${randomUUID()}`;
      const now = new Date();
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
          [
            transactionId,
            reversalId,
            movement.currency,
            direction,
            fixed(value),
            now,
          ],
        );
      }
      await client.query(
        "INSERT INTO ledger_reversals (reversal_id,transaction_id,actor_id,reason,posted_at) VALUES ($1,$2,$3,$4,$5)",
        [reversalId, transactionId, actor.userId, reason, now],
      );
      await client.query(
        "INSERT INTO ledger_reversal_entries (reversal_id,account_code,side,amount_cad,created_at) SELECT $1,account_code,CASE side WHEN 'debit' THEN 'credit' ELSE 'debit' END,amount_cad,$2 FROM ledger_journal_entries WHERE transaction_id=$3",
        [reversalId, now, transactionId],
      );
      const response = {
        reversalId,
        transactionId,
        postedAt: now.toISOString(),
      };
      await client.query(
        "INSERT INTO ledger_audit_events (event_id,tenant_id,legal_entity_id,branch_id,workspace_id,actor_id,action,target_id,reason,correlation_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,'transaction.reverse',$7,$8,$9,$10)",
        [
          randomUUID(),
          ...scope(actor).slice(0, 4),
          actor.userId,
          transactionId,
          reason,
          idempotencyKey,
          now,
        ],
      );
      await client.query(
        "UPDATE ledger_idempotency SET response=$1 WHERE tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 AND operation='reverse' AND idempotency_key=$7",
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
}
