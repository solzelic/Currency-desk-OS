import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import pg from "pg";
import {
  hasBackendPermission,
  type BackendPermission,
} from "../auth/permissions.js";
import { withSerializationRetry } from "./retry.js";
import {
  acquire,
  currentBasis,
  dispose,
  ensureBasis,
  reverseEvent,
} from "./cost-basis.js";
import {
  pairAllowed,
  resolvePack,
  type JurisdictionPack,
} from "./jurisdiction.js";
import { resolveIdThreshold, resolveReportThreshold } from "./thresholds.js";

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
  thirdParty?: boolean;
  thirdPartyName?: string;
};
export type FrozenQuote = {
  quoteId: string;
  customerId: string;
  from: Currency;
  to: Currency;
  inputAmount: string;
  outputAmount: string;
  marketMid: string;
  /* A cross is priced off two board rows and `marketMid` can only hold
     one of them, so both travel and both are checked. Null on an ordinary
     deal, where one side IS the home currency and its rate is 1. */
  fromMid?: string | null;
  toMid?: string | null;
  customerRate: string;
  feeCad: string;
  spreadCad: string;
  rateBoardPublicationId: string;
  marketSnapshotId: string | null;
  rateSourceType: "market_sync" | "manual" | "seed";
  quoteOverrideId: string | null;
  purpose: string;
  sourceOfFunds: string;
  thirdParty?: boolean;
  thirdPartyName?: string | null;
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

/* ---- the two gates every counter deal passes, wherever it is posted ----

   These were private methods on LedgerService while an exchange was the
   only thing that could be posted. Cheque cashing is the second, and it
   has to pass exactly the same two: a drawer that is not open cannot pay
   anybody, and the desk's identification line does not become optional
   because the customer handed over paper instead of notes. Copies of them
   in a second service would be two rules, and the day somebody moved the
   line one of the copies would not follow. */

export async function requireOpenTill(
  client: pg.PoolClient,
  actor: LedgerActor,
) {
  const session = await client.query(
    `SELECT status
       FROM ledger_till_sessions
      WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3
        AND workspace_id=$4 AND till_id=$5
      ORDER BY session_number DESC
      LIMIT 1
      FOR SHARE`,
    scope(actor),
  );
  if (!session.rowCount || session.rows[0].status !== "open") {
    throw new LedgerError(
      "TILL_NOT_OPEN",
      "Open the till before posting transactions.",
    );
  }
}

/* ---- the identification gate ----

   The most load-bearing compliance number in the product, and until now
   it was the literal 3,000 in a comparison against a variable called
   `inputCad`. Every desk got Canada's figure: a British desk whose pack
   says 1,000 cleared four deals in five that it should have identified,
   and a UAE desk on 3,500 dirhams refused deals it was entitled to take.

   Two things this now gets right. The comparison is in the currency the
   PACK states the book is kept in, which is the currency `amountHome`
   already arrived in. And the line is the DESK's — its own choice where
   it has made one, the pack's where it has not. A desk may set this
   tighter than its regulator requires at any time, and the moment it
   does, the next deal is judged at the new number.

   ---- and when nothing can answer ----

   `resolveIdThreshold` returns null when neither the desk nor its pack
   states a line. That is a broken desk rather than a permissive one, and
   the two available blanket answers are both wrong: a gate that never
   fires clears deals nobody checked, and a gate that always fires stops
   a working shop trading.

   So it is not a blanket answer. A customer who is already verified
   satisfies every possible value of a line nobody can state — there is
   nothing to be unsure about, and that desk keeps trading. An unverified
   one is exactly the case the gate exists for, and "we could not work
   out whether ID was needed, so it wasn't" is not something anybody can
   say to a regulator. That deal is refused, in words that name the real
   problem, because the fix is a minute of somebody's time and the
   alternative is a silent hole in the desk's file. The browser follows
   the same rule for the reporting line — see `overReportingLimit` in
   os-src/cdos-base.jsx, which answers null rather than false. */
export async function requireIdentification(
  client: pg.PoolClient,
  actor: LedgerActor,
  pack: JurisdictionPack,
  amountHome: Decimal,
  idStatus: unknown,
) {
  if (idStatus === "verified") return;
  const line = await resolveIdThreshold(client, actor.legalEntityId, pack);
  if (line === null)
    throw new LedgerError(
      "COMPLIANCE_BLOCKED",
      "This desk has no identification threshold, so it cannot tell whether this customer needs to be identified. Set one in Settings, or ask your jurisdiction pack to be installed.",
    );
  if (amountHome.gte(line))
    throw new LedgerError(
      "COMPLIANCE_BLOCKED",
      "Authoritative compliance policy blocked posting.",
    );
}

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

  private requireOpenTill(client: pg.PoolClient, actor: LedgerActor) {
    return requireOpenTill(client, actor);
  }

  private requireIdentification(
    client: pg.PoolClient,
    actor: LedgerActor,
    pack: JurisdictionPack,
    amountHome: Decimal,
    idStatus: unknown,
  ) {
    return requireIdentification(client, actor, pack, amountHome, idStatus);
  }

  /* Retried on a serialization failure, like every other write here. A
     post takes the till's balance rows and the session at SERIALIZABLE, so
     it aborts whenever anything else touches the same drawer — including
     the screen behind the teller refreshing. Nothing is committed when it
     does, and the idempotency key makes a second attempt safe. */
  postFrozenQuote(actor: LedgerActor, quote: FrozenQuote, idempotencyKey: string) {
    return withSerializationRetry(() =>
      this.postFrozenQuoteOnce(actor, quote, idempotencyKey));
  }

  private async postFrozenQuoteOnce(
    actor: LedgerActor,
    quote: FrozenQuote,
    idempotencyKey: string,
  ) {
    if (
      (!!quote.thirdParty && !quote.thirdPartyName?.trim()) ||
      (!quote.thirdParty && !!quote.thirdPartyName?.trim())
    )
      throw new LedgerError(
        "INVALID_REQUEST",
        "Third-party status and name must be captured together.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:post");
      await this.requireOpenTill(client, actor);
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
      /* What currency is this desk's book kept in, and may it trade this
         pair at all? Asked of the jurisdiction pack, not assumed. This
         used to demand that CAD be one side of every exchange, which is
         the pilot's limitation written down as a rule — a customer with
         dollars who wants euros is ordinary business for a currency desk. */
      const pack = await resolvePack(client, actor.legalEntityId);
      const home = pack.homeCurrency;
      const permitted = pairAllowed(pack, row.from_currency, row.to_currency);
      if (!permitted.ok)
        throw new LedgerError("UNSUPPORTED_CURRENCY_PAIR", permitted.reason);
      if (row.status !== "active")
        throw new LedgerError("QUOTE_NOT_ACTIVE", "Quote cannot be posted.");
      if (new Date(row.expires_at).getTime() <= Date.now())
        throw new LedgerError("QUOTE_EXPIRED", "Quote has expired.");
      const override = await client.query(
        "SELECT override_id,overridden_customer_rate,overridden_output_amount,overridden_spread_cad FROM quote_overrides WHERE quote_id=$1 ORDER BY created_at DESC LIMIT 1",
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
      /* A cross carries two rates, and checking one of them is checking
         half the price: move the mid nobody looked at and the deal posts
         at a number the customer was never quoted. Presence has to match
         too, or the check is skipped simply by omitting the field. */
      const sameMid = (stored: string | null, submitted: string | null | undefined) =>
        stored == null || submitted == null
          ? (stored ?? null) === (submitted ?? null)
          : sameDecimal(stored, submitted, 12);
      if (
        quote.quoteId !== row.quote_id ||
        !sameMid(row.from_mid ?? null, quote.fromMid) ||
        !sameMid(row.to_mid ?? null, quote.toMid) ||
        row.customer_id !== quote.customerId ||
        row.from_currency !== quote.from || row.to_currency !== quote.to ||
        !sameDecimal(row.input_amount, quote.inputAmount, 2) ||
        !sameDecimal(expectedOutput, quote.outputAmount, 2) ||
        !sameDecimal(row.market_mid, quote.marketMid, 12) ||
        !sameDecimal(expectedRate, quote.customerRate, 12) ||
        !sameDecimal(row.fee_cad, quote.feeCad, 2) ||
        !sameDecimal(expectedSpread, quote.spreadCad, 2) ||
        row.rate_board_publication_id !== quote.rateBoardPublicationId ||
        (row.market_snapshot_id ?? null) !== (quote.marketSnapshotId ?? null) ||
        row.rate_source_type !== quote.rateSourceType ||
        (override.rows[0]?.override_id ?? null) !== quote.quoteOverrideId
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
      /* Both sides are foreign, so both are inventory and neither rate can
         be inferred. A cross must carry both or there is nothing to value
         it with — and valuing it off one mid would price the pair
         one-for-one, which is not a rounding error, it is a giveaway. */
      const crossing = quote.from !== home && quote.to !== home;
      if (crossing && (quote.fromMid == null || quote.toMid == null))
        throw new LedgerError(
          "QUOTE_MISMATCH",
          "A cross-currency deal must carry both frozen board mids.",
        );
      const sideMid = (currency: string, frozen: string | null | undefined) =>
        frozen != null
          ? new Decimal(frozen)
          : currency === home
            ? new Decimal(1)
            : mid;
      const fromMid = sideMid(quote.from, quote.fromMid);
      const toMid = sideMid(quote.to, quote.toMid);
      /* What the deal is worth to the desk, in the currency its book is
         kept in, taken on each side at that side's own rate. */
      const inputHome = input.mul(fromMid).toDecimalPlaces(2);
      const outputCad = output.mul(toMid).toDecimalPlaces(2);
      await this.requireIdentification(
        client,
        actor,
        pack,
        inputHome,
        customer.rows[0].id_status,
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
      /* ---------------- COST BASIS ----------------
         Whichever side of this exchange is not the home currency is
         inventory, and on a cross that is BOTH of them:

           customer pays foreign  → the desk ACQUIRES it, at what it paid
           customer takes foreign → the desk DISPOSES of it, and the margin
                                    between the proceeds and what those
                                    units actually cost is realized here

         The journal that follows carries the inventory leg AT COST rather
         than at the market mid it used to use. A mid is a reference price
         nobody paid; carrying stock at it books a gain the instant a trade
         happens and leaves the desk unable to say whether it made money on
         a currency over a week. See docs/COST_BASIS.md. */
      const costScope = {
        tenantId: actor.tenantId,
        legalEntityId: actor.legalEntityId,
        branchId: actor.branchId,
        locationKind: "till" as const,
        locationId: actor.tillId,
      };
      const acquiring = quote.from !== home;   // foreign came in
      const disposing = quote.to !== home;     // foreign went out
      const basis = disposing
        ? await currentBasis(client, { ...costScope, currency: quote.to })
        : null;
      if (disposing && basis && basis.avgCost === null && basis.quantity.gt(0)) {
        /* Stock the desk held before cost tracking existed. The board mid
           for THIS side is the best figure available, and the event records
           that it was an estimate. On a cross the two sides have different
           mids, and falling back to the other one's would put dollars into
           the book at the price of euros. */
        basis.avgCost = await ensureBasis(
          client,
          { ...costScope, currency: quote.to },
          {
            fallbackUnitCostHome: toMid,
            quantity: basis.quantity,
            avgCost: null,
            actorId: actor.userId,
            now: new Date(),
            sourceKind: "quote",
            sourceId: quote.quoteId,
          },
        );
      }
      const acquiredBasis = acquiring
        ? await currentBasis(client, { ...costScope, currency: quote.from })
        : null;
      if (acquiring && acquiredBasis && acquiredBasis.avgCost === null && acquiredBasis.quantity.gt(0)) {
        /* Stock already in the drawer with no recorded cost. Without this,
           a small purchase would silently become the average for the whole
           pile — re-pricing cash it had nothing to do with. Give what was
           already there its own estimated basis first, so the purchase
           blends against it instead of overwriting it. */
        acquiredBasis.avgCost = await ensureBasis(
          client,
          { ...costScope, currency: quote.from },
          {
            fallbackUnitCostHome: fromMid,
            quantity: acquiredBasis.quantity,
            avgCost: null,
            actorId: actor.userId,
            now: new Date(),
            sourceKind: "quote",
            sourceId: quote.quoteId,
          },
        );
      }

      /* What the desk actually gave up, and actually received, in home
         currency — the customer's rate, not the mid. The fee is charged on
         top and is fee revenue, not part of the exchange.

         On a cross no home currency changes hands at all, and the deal is
         valued on the side that ARRIVED: that is the cash the desk is
         actually holding, and pricing off it leaves the margin as the only
         thing moving the customer's number. */
      const proceedsHome = disposing ? inputHome : null;   // they paid us this
      const paidHome = acquiring ? outputCad : null;      // we paid them this

      const now = new Date(),
        transactionId = `tx_${randomUUID()}`,
        transactionRef = `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${transactionId.slice(-6)}`;

      /* The stock leaves here, BEFORE the journal is written, because the
         journal has to carry the figure the disposal actually produced.
         Under weighted average that is output × the running average, which
         is what this used to compute for itself; under FIFO it is what the
         oldest lots cost, and a journal still doing its own arithmetic
         against the average would disagree with the cost events behind it —
         two books again, in the one place the whole file exists to keep
         singular. `quantityBefore` is the pre-move balance for the same
         reason it always was: the till balances move further down. */
      const sale =
        disposing && basis
          ? await dispose(client, { ...costScope, currency: quote.to }, {
              quantity: output,
              quantityBefore: basis.quantity,
              avgCostBefore: basis.avgCost,
              proceedsHome: proceedsHome ?? undefined,
              eventKind: "sale",
              sourceKind: "transaction",
              sourceId: transactionId,
              actorId: actor.userId,
              now,
            })
          : null;
      const costOfSale = sale ? sale.costOfSale : new Decimal(0);
      const realized = sale?.realized ?? new Decimal(0);

      const journal = crossing
        ? ([
            /* Both sides are stock. The currency arriving comes in at what
               the deal says it is worth; the currency leaving goes out AT
               COST, and everything between them — the margin taken twice,
               plus whatever the desk made or lost holding that currency —
               is realized. Nothing here touches the home currency except
               the fee, because nothing here IS the home currency. */
            [`till:${quote.from}`, "debit", inputHome],
            [`till:${home}`, "debit", fee],
            [`till:${quote.to}`, "credit", costOfSale],
            ["revenue:fx_trading", realized.gte(0) ? "credit" : "debit", realized.abs()],
            ["revenue:fee", "credit", fee],
          ] as const)
        : disposing
        ? ([
            // sold foreign: home currency in, stock out AT COST, margin realized.
            // The exchange and the fee stay separate lines — they are separate
            // things, and a journal you cannot read them apart in is worse.
            [`till:${home}`, "debit", inputHome],
            [`till:${home}`, "debit", fee],
            [`till:${quote.to}`, "credit", costOfSale],
            ["revenue:fx_trading", realized.gte(0) ? "credit" : "debit", realized.abs()],
            ["revenue:fee", "credit", fee],
          ] as const)
        : ([
            // bought foreign: stock in AT WHAT WE PAID, home currency out.
            // Nothing is earned buying — the margin comes when it is sold.
            [`till:${quote.from}`, "debit", paidHome ?? inputHome],
            [`till:${home}`, "debit", fee],
            [`till:${home}`, "credit", paidHome ?? outputCad],
            ["revenue:fee", "credit", fee],
          ] as const);
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
        rateSourceType: quote.rateSourceType,
        quoteOverrideId: quote.quoteOverrideId,
        receipt: {
          receiptId: `rcpt_${transactionId}`,
          lines: [
            "CurrencyDesk OS",
            `Receipt ${transactionRef}`,
            `Customer: ${customer.rows[0].name}`,
            `Quote: ${quote.quoteId}`,
            `Paid exchange: ${fixed(input)} ${quote.from}`,
            `Fee paid separately: ${home} ${fixed(fee)}`,
            `Received: ${fixed(output)} ${quote.to}`,
          ],
        },
      };
      await client.query(
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,compliance_captured_by,compliance_captured_at,quote_id,market_mid,rate_board_publication_id,market_snapshot_id,rate_source_type,quote_override_id,posted_at,realized_pnl_home,cost_of_sale_home,deal_kind,received_instrument,disbursed_instrument) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)",
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
          quote.purpose,
          quote.sourceOfFunds,
          !!quote.thirdParty,
          quote.thirdParty ? quote.thirdPartyName?.trim() || null : null,
          actor.userId,
          now,
          quote.quoteId,
          fixed(mid, 12),
          quote.rateBoardPublicationId,
          quote.marketSnapshotId,
          quote.rateSourceType,
          quote.quoteOverrideId,
          now,
          // what the desk actually made on this deal, and what the cash it
          // handed over had cost it. Null on a purchase — buying earns nothing.
          disposing ? fixed(realized) : null,
          disposing ? fixed(costOfSale) : null,
          /* An exchange over the counter: notes in, notes out. Stated
             rather than defaulted, because migration 017 dropped the
             column default precisely so that a deal type which is NOT
             cash has to say so instead of inheriting a claim. */
          "exchange",
          "cash",
          "cash",
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
        // the fee is cash too, and it is collected in the desk's own currency
        [home, "in", fee],
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

      /* The basis moves with the cash. Quantities have just changed, so the
         pre-move figures captured above are what the weighted average is
         taken against — an average computed against a balance that has
         already moved is the wrong number, quietly. The disposal already
         happened, above, so that the journal could be written from it. */
      if (acquiring && acquiredBasis) {
        await acquire(client, { ...costScope, currency: quote.from }, {
          quantity: input,
          /* What a unit actually cost. On an ordinary purchase that is the
             home currency handed over, divided by the units received. On a
             cross nothing home-currency was handed over — what the desk
             gave up was other stock — so the arriving cash enters at the
             rate the deal was valued at, and the whole margin is realized
             on the disposal side rather than half-hidden in this basis. */
          unitCostHome: crossing
            ? fromMid
            : (paidHome ?? new Decimal(0)).div(input),
          quantityBefore: acquiredBasis.quantity,
          avgCostBefore: acquiredBasis.avgCost,
          eventKind: "purchase",
          sourceKind: "transaction",
          sourceId: transactionId,
          actorId: actor.userId,
          now,
        });
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

  post(actor: LedgerActor, request: PostRequest) {
    return withSerializationRetry(() => this.postOnce(actor, request));
  }

  private async postOnce(actor: LedgerActor, request: PostRequest) {
    if (!request.idempotencyKey || request.from === request.to)
      throw new LedgerError(
        "INVALID_REQUEST",
        "Idempotency key and distinct currencies are required.",
      );
    if (
      (!!request.thirdParty && !request.thirdPartyName?.trim()) ||
      (!request.thirdParty && !!request.thirdPartyName?.trim())
    )
      throw new LedgerError(
        "INVALID_REQUEST",
        "Third-party status and name must be captured together.",
      );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:post");
      await this.requireOpenTill(client, actor);
      /* Whether this pair may be traded is the jurisdiction's answer, not a
         constant. This used to demand CAD on one side, which is the pilot's
         limitation and not a rule anywhere. It has to be asked inside the
         transaction because the pack is read through the same client. */
      const pack = await resolvePack(client, actor.legalEntityId);
      const permitted = pairAllowed(pack, request.from, request.to);
      if (!permitted.ok)
        throw new LedgerError("UNSUPPORTED_CURRENCY_PAIR", permitted.reason);
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
      /* `units_per_cad` is the pilot's name for a rate against the book's
         own currency, kept because renaming a column is not free. The
         figure it produces is home currency, whatever the pack says home
         is — which is why it is no longer called `inputCad`. */
      const inputHome = input.div(rates[request.from]).toDecimalPlaces(2);
      const output = input.mul(rate).toDecimalPlaces(2);
      const outputCad = output.div(rates[request.to]).toDecimalPlaces(2);
      const spread = inputHome.sub(outputCad).toDecimalPlaces(2);
      await this.requireIdentification(
        client,
        actor,
        pack,
        inputHome,
        customer.rows[0].id_status,
      );
      /* Purpose and source of funds, over the desk's REPORTING line — the
         details the report itself is made of. Same story as the ID gate: a
         hardcoded 10,000 in a book that might be kept in dirhams, where
         the figure is 55,000. Resolved from the same place, and a capture
         that is present clears it whatever the line turns out to be. */
      if (!request.purpose.trim() || !request.sourceOfFunds.trim()) {
        const reporting = await resolveReportThreshold(
          client,
          actor.legalEntityId,
          pack,
        );
        if (reporting === null || inputHome.gte(reporting))
          throw new LedgerError(
            "COMPLIANCE_BLOCKED",
            reporting === null
              ? "This desk has no reporting threshold, so a deal cannot be posted without its purpose and source of funds. Set one in Settings, or ask your jurisdiction pack to be installed."
              : "Authoritative compliance policy blocked posting.",
          );
      }
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
        [`till:${request.from}`, "debit", inputHome],
        ["till:CAD", "debit", fee],
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
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,compliance_captured_by,compliance_captured_at,posted_at,deal_kind,received_instrument,disbursed_instrument) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)",
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
          !!request.thirdParty,
          request.thirdParty ? request.thirdPartyName?.trim() || null : null,
          actor.userId,
          now,
          now,
          // notes in, notes out — see the same three values in postFrozenQuote
          "exchange",
          "cash",
          "cash",
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

  reverse(
    actor: LedgerActor,
    transactionId: string,
    idempotencyKey: string,
    reason: string,
  ) {
    return withSerializationRetry(() =>
      this.reverseOnce(actor, transactionId, idempotencyKey, reason));
  }

  private async reverseOnce(
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
        "SELECT deal_kind FROM ledger_transactions WHERE transaction_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE",
        [transactionId, ...scope(actor)],
      );
      if (!transaction.rowCount)
        throw new LedgerError(
          "TRANSACTION_NOT_FOUND",
          "Transaction not found.",
        );
      /* This path knows about an exchange and about the cost events an
         exchange leaves behind. It knows nothing about the OBLIGATION a
         remittance, a bill payment or a money order leaves behind, and a
         reversal that mirrored the cash and the journal while leaving the
         payout still owed would be a hole in the book that balanced
         perfectly — the worst kind. Those go to
         ObligationService.reverse, which strikes the promise out as well.

         Named rather than filtered by exclusion: the day a seventh deal
         type arrives, being refused here is a great deal safer than being
         silently half-reversed. */
      if (
        ["remittance_send", "remittance_receive", "bill_payment", "money_order",
         "obligation_settlement", "obligation_write_off"]
          .includes(transaction.rows[0].deal_kind)
      )
        throw new LedgerError(
          "REVERSAL_NOT_ALLOWED",
          "This deal left an obligation on the book, so it is reversed through the obligation path — see docs/OBLIGATION_LINES.md.",
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
      /* The cash has come back; so must what it cost.

         Without this the desk keeps the margin on a deal that never
         happened — the till balances return to where they were, the journal
         is mirrored, and `ledger_cost_events` still carries the sale and its
         realized P&L with nothing to say it was undone. A month of voided
         deals reads as a month of profit.

         Reversed newest first, so a cross undoes its purchase before its
         sale, and only the legs THIS transaction posted: the estimated
         opening basis that may have been seeded alongside it is sourced to
         the quote, and it stays. That cash is still in the drawer and still
         needs a basis. */
      const costLegs = await client.query(
        `SELECT event_id FROM ledger_cost_events
          WHERE source_kind='transaction' AND source_id=$1
          ORDER BY created_at DESC, event_id DESC`,
        [transactionId],
      );
      for (const leg of costLegs.rows) {
        await reverseEvent(client, leg.event_id, {
          sourceKind: "reversal",
          sourceId: reversalId,
          actorId: actor.userId,
          now,
        });
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
