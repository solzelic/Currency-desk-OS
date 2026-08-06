import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import pg from "pg";
import {
  hasBackendPermission,
  type BackendPermission,
} from "../auth/permissions.js";
import { pairAllowed, resolvePack } from "../ledger/jurisdiction.js";
import { assertTradeable } from "../ledger/currencies.js";
import { withSerializationRetry } from "../ledger/retry.js";
import {
  LedgerError,
  LedgerService,
  type FrozenQuote,
  type LedgerActor,
} from "../ledger/service.js";
import { calculateQuoteTerms, type QuoteDirection } from "./terms.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
/* A currency, as a code. This was a four-way union — CAD, USD, EUR, GBP
   — which is what a `char(3)` column had been narrowed to by hand. It
   was the type-level half of the ceiling described in migration 020: a
   desk trading pesos could not be represented, never mind stored. What
   a given desk may hold is data, and it is resolved per desk in
   ../ledger/currencies.ts. */
type Currency = string;
export type QuoteRequest = {
  customerId: string;
  from: Currency;
  to: Currency;
  inputAmount: string;
  feeCad: string;
  direction: QuoteDirection;
  supersedesQuoteId?: string;
};
const scope = (a: LedgerActor) => [
  a.tenantId,
  a.legalEntityId,
  a.branchId,
  a.workspaceId,
  a.tillId,
];
const fixed = (v: Decimal, p = 2) => v.toDecimalPlaces(p).toFixed(p);

/**
 * How old a published board may be and still be quotable.
 *
 * This has to be DERIVED from how often the board is refreshed, not picked
 * independently, because the two settings shipped in contradiction: the
 * market sync republishes every RATES_SYNC_MINUTES (default 60) and this
 * tolerance defaulted to a flat 300 seconds. A desk on the defaults could
 * quote for five minutes an hour and was refused for the other fifty-five,
 * with "Rate publication is stale." and no way for a teller to act on it.
 * Any fixed number shorter than the refresh cadence guarantees a dead
 * window, so the default is one full cycle plus ten minutes of headroom
 * for a slow or missed provider pull.
 *
 * With the sync off, nothing refreshes the board but a person, and a
 * manager who publishes at open should be able to trade the shift on it —
 * so the fallback is a working day rather than five minutes. It is still a
 * ceiling: yesterday's board is refused, which is what the check is for.
 *
 * RATE_BOARD_MAX_AGE_SECONDS overrides all of it, and a desk that genuinely
 * wants a five-minute tolerance can still say so.
 */
export function boardMaxAgeSeconds(): number {
  const stated = process.env.RATE_BOARD_MAX_AGE_SECONDS;
  if (stated != null && stated !== "") return Number(stated);
  if (process.env.RATES_SYNC === "off") return 12 * 60 * 60;
  const syncMinutes = Math.max(1, Number(process.env.RATES_SYNC_MINUTES ?? 60));
  return syncMinutes * 60 + 10 * 60;
}
const complianceFact = (value: string, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500)
    throw new LedgerError("INVALID_REQUEST", `${label} is required and must be at most 500 characters.`);
  return value.trim();
};

export class QuoteService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ledger = new LedgerService(pool),
  ) {}
  private async principal(
    client: pg.PoolClient,
    actor: LedgerActor,
    permission: BackendPermission,
  ) {
    const found = await client.query(
      "SELECT role,authorized_branch_ids FROM ledger_principals WHERE user_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5 AND till_id=$6 FOR UPDATE",
      [actor.userId, ...scope(actor)],
    );
    if (!found.rowCount)
      throw new LedgerError(
        "SCOPE_DENIED",
        "Authenticated principal is outside this workspace.",
      );
    if (
      !hasBackendPermission(found.rows[0].role, permission) ||
      !found.rows[0].authorized_branch_ids.includes(actor.branchId)
    )
      throw new LedgerError("AUTHORIZATION_DENIED", `Missing ${permission}.`);
  }
  private async event(
    client: pg.PoolClient,
    quoteId: string,
    actorId: string,
    eventType: string,
    detail: unknown,
  ) {
    await client.query(
      "INSERT INTO quote_events (event_id,quote_id,actor_id,event_type,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        quoteId,
        actorId,
        eventType,
        JSON.stringify(detail),
        new Date(),
      ],
    );
  }
  private async effective(client: pg.PoolClient, quoteId: string) {
    const quote = await client.query("SELECT * FROM quotes WHERE quote_id=$1", [
      quoteId,
    ]);
    if (!quote.rowCount)
      throw new LedgerError("QUOTE_NOT_FOUND", "Quote not found.");
    const override = await client.query(
      "SELECT * FROM quote_overrides WHERE quote_id=$1 ORDER BY created_at DESC LIMIT 1",
      [quoteId],
    );
    const q = quote.rows[0],
      o = override.rows[0];
    return {
      q,
      o,
      customerRate: o?.overridden_customer_rate ?? q.customer_rate,
      outputAmount: o?.overridden_output_amount ?? q.output_amount,
      spreadCad: o?.overridden_spread_cad ?? q.spread_cad,
    };
  }
  private response(value: Awaited<ReturnType<QuoteService["effective"]>>) {
    const { q, o, customerRate, outputAmount, spreadCad } = value;
    return {
      quoteId: q.quote_id,
      status: q.status,
      expiresAt: new Date(q.expires_at).toISOString(),
      from: q.from_currency,
      to: q.to_currency,
      inputAmount: q.input_amount,
      outputAmount,
      marketMid: q.market_mid,
      /* Null on an ordinary deal, where one side IS the home currency and
         its rate is 1 by definition. A cross carries both, because the
         pair is priced off two board rows and neither one describes it. */
      fromMid: q.from_mid ?? null,
      toMid: q.to_mid ?? null,
      customerRate,
      buyOrSellSide: q.buy_or_sell_side,
      feeCad: q.fee_cad,
      spreadCad,
      rateBoardPublicationId: q.rate_board_publication_id,
      marketSnapshotId: q.market_snapshot_id,
      rateSourceType: q.rate_source_type,
      override: o
        ? {
            overrideId: o.override_id,
            actorId: o.actor_id,
            reason: o.reason,
            createdAt: new Date(o.created_at).toISOString(),
            customerRate: o.overridden_customer_rate,
          }
        : null,
    };
  }
  /* Retried on a serialization failure, like every write on the ledger
     side. Quoting is not a write in the teller's mind, but it takes the
     principal row and the quote table at SERIALIZABLE and it is the single
     most-hit path at a counter — so it aborts against anything else the
     desk is doing, and an abort here reached the teller as an unexplained
     failure on the one action they take before every deal. See
     ../ledger/retry.ts. */
  create(actor: LedgerActor, request: QuoteRequest) {
    return withSerializationRetry(() => this.createOnce(actor, request));
  }

  private async createOnce(actor: LedgerActor, request: QuoteRequest) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "quote:create");
      /* Which country's rules is this desk under, and what does it book in?
         Asked, not assumed — this used to test against the literal "CAD",
         which quoted a London desk in the wrong currency and refused a
         cross-currency deal that its jurisdiction actually permits. */
      const pack = await resolvePack(client, actor.legalEntityId);
      const home = pack.homeCurrency;
      const permitted = pairAllowed(pack, request.from, request.to);
      if (!permitted.ok)
        throw new LedgerError("UNSUPPORTED_CURRENCY_PAIR", permitted.reason);
      /* And whether THIS desk trades them, which is a different question
         from whether the jurisdiction permits the pair. The pack says what
         is legal here; the desk says what is in its drawers. Both have to
         agree, and until migration 020 the second was a four-way enum in
         the route rather than anything the desk had said. */
      await assertTradeable(
        client,
        {
          legalEntityId: actor.legalEntityId,
          branchId: actor.branchId,
          homeCurrency: pack.homeCurrency,
        },
        request.from,
        request.to,
      );
      /* The currencies and the home currency between them already say what
         shape this deal is. A caller who states a different one has built
         the wrong request, and there is no safe way to pick which half of
         the disagreement was right. */
      const shape: QuoteDirection =
        request.from === home
          ? "customer_buy_foreign"
          : request.to === home
            ? "customer_sell_foreign"
            : "customer_cross";
      if (shape !== request.direction)
        throw new LedgerError(
          "INVALID_REQUEST",
          "Transaction direction does not match the currency pair.",
        );
      const customer = await client.query(
        "SELECT 1 FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5",
        [request.customerId, ...scope(actor).slice(0, 4)],
      );
      if (!customer.rowCount)
        throw new LedgerError(
          "CUSTOMER_NOT_FOUND",
          "Customer is not in active workspace.",
        );
      const boards = await client.query(
        "SELECT * FROM rate_boards WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 ORDER BY published_at DESC LIMIT 1",
        scope(actor).slice(0, 3),
      );
      if (!boards.rowCount)
        throw new LedgerError(
          "RATE_NOT_AVAILABLE",
          "No published branch board.",
        );
      const board = boards.rows[0],
        maxAge = boardMaxAgeSeconds();
      if (
        !Number.isFinite(maxAge) ||
        maxAge < 1 ||
        Date.now() - new Date(board.published_at).getTime() > maxAge * 1000
      )
        throw new LedgerError(
          "RATE_PUBLICATION_STALE",
          "Rate publication is stale.",
        );
      /* Both sides of a cross come off the SAME publication. Reading one
         mid from this board and the other from whatever is current would
         price the pair off two moments in the market, and the difference
         between those moments is a number nobody quoted. */
      const publishedMid = (currency: string) => {
        const row = board.board_rows[currency];
        if (!row || row.show === false)
          throw new LedgerError(
            "RATE_NOT_AVAILABLE",
            "Currency is not published.",
          );
        return row;
      };
      let terms;
      try {
        if (shape === "customer_cross") {
          const fromRow = publishedMid(request.from);
          const toRow = publishedMid(request.to);
          terms = calculateQuoteTerms({
            direction: shape,
            from: request.from,
            to: request.to,
            inputAmount: request.inputAmount,
            feeCad: request.feeCad,
            /* Unused by a cross, but the shape of the input demands a rate.
               The incoming side is the one the deal is valued on. */
            marketMid: String(fromRow.mid),
            fromMid: String(fromRow.mid),
            toMid: String(toRow.mid),
            /* The desk buys the currency arriving and sells the one leaving,
               so each side takes the margin it would have taken had the
               customer done this as two deals through the home currency. */
            margin: String(fromRow.spread ?? board.buy_margin),
            outMargin: String(toRow.spread ?? board.sell_margin),
            homeCurrency: home,
          });
        } else {
          const row = publishedMid(
            shape === "customer_buy_foreign" ? request.to : request.from,
          );
          terms = calculateQuoteTerms({
            direction: shape,
            from: request.from,
            to: request.to,
            inputAmount: request.inputAmount,
            feeCad: request.feeCad,
            marketMid: String(row.mid),
            margin: String(
              row.spread ??
                (shape === "customer_buy_foreign"
                  ? board.sell_margin
                  : board.buy_margin),
            ),
            homeCurrency: home,
          });
        }
      } catch (error) {
        if (error instanceof LedgerError) throw error;
        throw new LedgerError("INVALID_REQUEST", "Invalid commercial terms.");
      }
      const {
        input,
        fee,
        mid,
        customerRate: rate,
        outputAmount: output,
        spreadCad: spread,
      } = terms;
      if (request.supersedesQuoteId) {
        const previous = await client.query(
          "SELECT 1 FROM quotes WHERE quote_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5",
          [request.supersedesQuoteId, ...scope(actor).slice(0, 4)],
        );
        if (!previous.rowCount)
          throw new LedgerError(
            "SCOPE_DENIED",
            "Superseded quote is outside active scope.",
          );
      }
      const rateSourceType = board.market_snapshot_id
        ? "market_sync"
        : board.published_by === "seed"
          ? "seed"
          : "manual";
      const quoteId = `qt_${randomUUID()}`,
        now = new Date(),
        expiresAt = new Date(
          now.getTime() + Number(process.env.QUOTE_TTL_SECONDS ?? 60) * 1000,
        );
      await client.query(
        "INSERT INTO quotes (quote_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,created_by,direction,from_currency,to_currency,input_amount,output_amount,market_mid,from_mid,to_mid,customer_rate,buy_or_sell_side,fee_cad,spread_cad,rate_board_publication_id,market_snapshot_id,rate_source_type,status,expires_at,created_at,supersedes_quote_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'active',$24,$25,$26)",
        [
          quoteId,
          ...scope(actor),
          request.customerId,
          actor.userId,
          shape,
          request.from,
          request.to,
          fixed(input),
          fixed(output),
          /* `market_mid` stays what it always was — the single rate this
             deal is valued at — so every reader downstream keeps working.
             On a cross that is the incoming side's mid. */
          fixed(mid, 12),
          /* Both mids are frozen only where both are real. On an ordinary
             deal the home side's rate is 1 by definition and storing it
             would invite somebody to tamper-check against a constant. */
          shape === "customer_cross" ? fixed(terms.fromMid, 12) : null,
          shape === "customer_cross" ? fixed(terms.toMid, 12) : null,
          fixed(rate, 12),
          terms.buyOrSellSide,
          fixed(fee),
          fixed(spread),
          board.id,
          board.market_snapshot_id ?? null,
          rateSourceType,
          expiresAt,
          now,
          request.supersedesQuoteId ?? null,
        ],
      );
      await this.event(client, quoteId, actor.userId, "created", {
        publicationId: board.id,
      });
      const result = this.response(await this.effective(client, quoteId));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async get(actor: LedgerActor, quoteId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.principal(client, actor, "quote:view");
      const value = await this.effective(client, quoteId);
      const q = value.q;
      if (
        q.tenant_id !== actor.tenantId ||
        q.legal_entity_id !== actor.legalEntityId ||
        q.branch_id !== actor.branchId ||
        q.workspace_id !== actor.workspaceId ||
        q.till_id !== actor.tillId
      )
        throw new LedgerError("SCOPE_DENIED", "Quote outside active scope.");
      if (
        q.status === "active" &&
        new Date(q.expires_at).getTime() <= Date.now()
      ) {
        await client.query(
          "UPDATE quotes SET status='expired' WHERE quote_id=$1",
          [quoteId],
        );
        q.status = "expired";
      }
      const result = this.response(value);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async cancel(actor: LedgerActor, quoteId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.principal(client, actor, "quote:cancel");
      const value = await this.effective(client, quoteId),
        q = value.q;
      if (
        q.tenant_id !== actor.tenantId ||
        q.legal_entity_id !== actor.legalEntityId ||
        q.branch_id !== actor.branchId ||
        q.workspace_id !== actor.workspaceId ||
        q.till_id !== actor.tillId
      )
        throw new LedgerError("SCOPE_DENIED", "Quote outside active scope.");
      if (q.status !== "active")
        throw new LedgerError(
          "QUOTE_NOT_ACTIVE",
          "Only active quotes can be cancelled.",
        );
      await client.query(
        "UPDATE quotes SET status='cancelled' WHERE quote_id=$1",
        [quoteId],
      );
      await this.event(client, quoteId, actor.userId, "cancelled", {});
      q.status = "cancelled";
      const result = this.response(value);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  override(
    actor: LedgerActor,
    quoteId: string,
    customerRate: string,
    reason: string,
  ) {
    return withSerializationRetry(() =>
      this.overrideOnce(actor, quoteId, customerRate, reason));
  }

  private async overrideOnce(
    actor: LedgerActor,
    quoteId: string,
    customerRate: string,
    reason: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "rates:override");
      if (!reason.trim())
        throw new LedgerError("INVALID_REQUEST", "Override reason required.");
      const value = await this.effective(client, quoteId),
        q = value.q;
      if (
        q.branch_id !== actor.branchId ||
        q.workspace_id !== actor.workspaceId ||
        q.tenant_id !== actor.tenantId ||
        q.legal_entity_id !== actor.legalEntityId
      )
        throw new LedgerError("SCOPE_DENIED", "Quote outside active scope.");
      if (
        q.status !== "active" ||
        new Date(q.expires_at).getTime() <= Date.now()
      )
        throw new LedgerError(
          "QUOTE_NOT_ACTIVE",
          "Only unexpired active quotes may be overridden.",
        );
      const rate = new Decimal(customerRate),
        original = new Decimal(q.customer_rate),
        limit = new Decimal(process.env.QUOTE_OVERRIDE_MAX_DEVIATION ?? "0.05");
      if (
        !rate.isFinite() ||
        rate.lte(0) ||
        rate.sub(original).abs().div(original).gt(limit)
      )
        throw new LedgerError(
          "OVERRIDE_LIMIT_EXCEEDED",
          "Override exceeds policy limit.",
        );
      /* What the overridden deal is worth to the desk, on both sides, in
         its own home currency. A cross has a real rate on each side and
         they are frozen on the quote; an ordinary deal has the home side
         at 1 by definition. Reading one mid for both — which is what
         testing against the literal "CAD" amounted to — values a
         foreign-to-foreign deal one-for-one. */
      const home = (await resolvePack(client, actor.legalEntityId))
        .homeCurrency;
      const mid = new Decimal(q.market_mid);
      const sideMid = (currency: string, frozen: string | null) =>
        frozen != null
          ? new Decimal(frozen)
          : currency === home
            ? new Decimal(1)
            : mid;
      const input = new Decimal(q.input_amount),
        output = input.mul(rate).toDecimalPlaces(2),
        inputCad = input
          .mul(sideMid(q.from_currency, q.from_mid))
          .toDecimalPlaces(2),
        outputCad = output
          .mul(sideMid(q.to_currency, q.to_mid))
          .toDecimalPlaces(2),
        spread = inputCad.sub(outputCad).toDecimalPlaces(2);
      if (spread.lt(0))
        throw new LedgerError(
          "OVERRIDE_LIMIT_EXCEEDED",
          "Override produces a negative spread.",
        );
      const id = `qov_${randomUUID()}`,
        now = new Date();
      await client.query(
        "INSERT INTO quote_overrides (override_id,quote_id,actor_id,original_market_mid,original_customer_rate,overridden_customer_rate,overridden_output_amount,overridden_spread_cad,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          id,
          quoteId,
          actor.userId,
          q.market_mid,
          q.customer_rate,
          fixed(rate, 12),
          fixed(output),
          fixed(spread),
          reason,
          now,
        ],
      );
      await this.event(client, quoteId, actor.userId, "overridden", {
        overrideId: id,
        reason,
      });
      const result = this.response(await this.effective(client, quoteId));
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async post(actor: LedgerActor, quoteId: string, idempotencyKey: string, purpose: string, sourceOfFunds: string, thirdParty = false, thirdPartyName?: string) {
    const validatedPurpose = complianceFact(purpose, "Purpose");
    const validatedSourceOfFunds = complianceFact(sourceOfFunds, "Source of funds");
    const validatedThirdPartyName = thirdParty
      ? complianceFact(thirdPartyName || "", "Third-party name")
      : null;
    if (!thirdParty && thirdPartyName?.trim())
      throw new LedgerError("INVALID_REQUEST", "Third-party name requires third-party status.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.principal(client, actor, "quote:post");
      const value = await this.effective(client, quoteId),
        q = value.q;
      if (
        q.tenant_id !== actor.tenantId ||
        q.legal_entity_id !== actor.legalEntityId ||
        q.branch_id !== actor.branchId ||
        q.workspace_id !== actor.workspaceId ||
        q.till_id !== actor.tillId
      )
        throw new LedgerError("SCOPE_DENIED", "Quote outside active scope.");
      if (q.status === "posted") {
        const replay = await client.query(
          "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='quote-post' AND idempotency_key=$6",
          [...scope(actor), idempotencyKey],
        );
        if (replay.rowCount && replay.rows[0].response) {
          await client.query("COMMIT");
          return replay.rows[0].response;
        }
        throw new LedgerError("QUOTE_NOT_ACTIVE", "Quote already posted.");
      }
      if (q.status !== "active")
        throw new LedgerError("QUOTE_NOT_ACTIVE", "Quote cannot be posted.");
      if (new Date(q.expires_at).getTime() <= Date.now())
        throw new LedgerError("QUOTE_EXPIRED", "Quote has expired.");
      await client.query("COMMIT");
      return this.ledger.postFrozenQuote(
        actor,
        {
          quoteId,
          customerId: q.customer_id,
          from: q.from_currency,
          to: q.to_currency,
          inputAmount: q.input_amount,
          outputAmount: value.outputAmount,
          marketMid: q.market_mid,
          fromMid: q.from_mid ?? null,
          toMid: q.to_mid ?? null,
          customerRate: value.customerRate,
          feeCad: q.fee_cad,
          spreadCad: value.spreadCad,
          rateBoardPublicationId: q.rate_board_publication_id,
          marketSnapshotId: q.market_snapshot_id,
          rateSourceType: q.rate_source_type,
          quoteOverrideId: value.o?.override_id ?? null,
          purpose: validatedPurpose,
          sourceOfFunds: validatedSourceOfFunds,
          thirdParty,
          thirdPartyName: validatedThirdPartyName,
        } as FrozenQuote,
        idempotencyKey,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
}
