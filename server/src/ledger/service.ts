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
import { AU_V2_PACK_ID, australiaIdentification } from "./australia-rules.js";
import {
  countryIdentification,
  type IdentificationDeal,
} from "./canada-rules.js";
import {
  baselineIdentification,
  foreignCurrencyIdentification,
  type ComplianceStamp,
} from "./compliance-gate.js";
import { holdSerbiaSuspicion, SERBIA_SUSPICION_HELD, serbiaExchangeFacts } from "./serbia.js";
import { euAmlrDuty, loadEuAmlrLines } from "./eu-amlr.js";
import {
  INDIA_PACK_ID,
  INDIA_PURPOSE_MESSAGE,
  INDIA_SALE_CASH_MESSAGE,
  indiaIdentificationRequired,
  indiaPurposeRequired,
  indiaSaleCashBlocked,
} from "./india-pack.js";
import {
  EU_AMLR_PACK_ID,
  pairAllowed,
  resolvePack,
  RULES_UNAVAILABLE_NOTICE,
  type JurisdictionPack,
} from "./jurisdiction.js";
import { idKindForDeal } from "./compliance-gate.js";
import {
  PH_BOOK_MESSAGE,
  PH_PAYOUT_BLOCK_MESSAGE,
  PH_PAYOUT_UNPRICED_MESSAGE,
  PH_PURPOSE_MESSAGE,
  PH_SALE_BLOCK_MESSAGE,
  PH_SALE_UNPRICED_MESSAGE,
  PH_UNPRICED_MESSAGE,
  identificationBlocks,
  isPhilippinesPack,
  philippinesCashPayout,
  philippinesDealPesos,
  philippinesFxSale,
  philippinesIdRow,
  philippinesPurposeRequired,
} from "./philippines-pack.js";
import { resolveIdThreshold, resolveReportThreshold } from "./thresholds.js";
import {
  purposeDecision,
  UK_PACK_V2,
  ukDueDiligenceBlocks,
} from "./uk-mlr.js";
import {
  AE_PACK_V2,
  aeDueDiligenceBlocks,
  aePurposeDecision,
} from "./uae-exchange.js";
import { assertTradeable } from "./currencies.js";
import {
  enhancedDueDiligenceGap,
  markSanctionsStop,
  recordSanctionsStop,
  screenDeal,
  type AuditLogger,
  type DealScreen,
} from "../compliance/sanctioned-jurisdictions.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
/* A currency, as a code. This was a four-way union — CAD, USD, EUR, GBP
   — which is what a `char(3)` column had been narrowed to by hand. It
   was the type-level half of the ceiling described in migration 020: a
   desk trading pesos could not be represented, never mind stored. What
   a given desk may hold is data, and it is resolved per desk in
   ./currencies.ts. */
type Currency = string;
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
  identityNumber?: string | null;
  usdLargeNotes?: boolean | null;
  usdNoteSerials?: string[] | null;
  reportSuspicion?: boolean | null;
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
  identityNumber?: string | null;
  usdLargeNotes?: boolean | null;
  usdNoteSerials?: string[] | null;
  reportSuspicion?: boolean | null;
};
export class LedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* A blocked jurisdiction throws, and the audit payload rides on the
   error so the caller can write it after ROLLBACK. Enhanced due
   diligence is not a stop: the deal posts once the client is
   identified in full and a reason and source of funds are present.
   A missing corridor is a validation error and is not audited. */
export function applyDealScreen(
  screen: DealScreen,
  compliance: {
    idStatus: string | null | undefined;
    purpose?: string | null;
    sourceOfFunds?: string | null;
  },
): void {
  switch (screen.outcome) {
    case "clear":
      return;
    case "enhanced_due_diligence": {
      const gap = enhancedDueDiligenceGap(
        screen.entry,
        compliance.idStatus,
        compliance.purpose,
        compliance.sourceOfFunds,
      );
      if (gap) throw new LedgerError(gap.code, gap.message);
      return;
    }
    case "invalid":
      throw new LedgerError(screen.code, screen.message);
    case "stop": {
      const error = new LedgerError(screen.code, screen.message);
      markSanctionsStop(error, screen.audit);
      throw error;
    }
    default: {
      const unreachable: never = screen;
      throw new LedgerError("INTERNAL_ERROR", `Unhandled deal screen: ${JSON.stringify(unreachable)}`);
    }
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
/* A country with no pack trades under the international baseline, so
   this guard passes for that desk. It refuses only when that baseline
   row is missing too. It sits on a quote, an exchange, a frozen quote,
   a cheque being cashed, and a new obligation. It does not sit on a
   void, a cheque clearance or return, or an obligation settlement or
   write-off — those record a deal already on the book. */
export function requireInstalledPack(pack: JurisdictionPack): void {
  if (pack.available) return;
  throw new LedgerError("no_jurisdiction_pack", RULES_UNAVAILABLE_NOTICE);
}

async function deskIdLine(client: pg.PoolClient, legalEntityId: string): Promise<Decimal | null> {
  const found = await client.query(
    "SELECT id_threshold FROM legal_entities WHERE id=$1",
    [legalEntityId],
  );
  const value = found.rows[0]?.id_threshold;
  if (value == null || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

export async function requireIdentification(
  client: pg.PoolClient,
  actor: LedgerActor,
  pack: JurisdictionPack,
  amountHome: Decimal,
  idStatus: unknown,
  deal: IdentificationDeal,
): Promise<ComplianceStamp & { identificationRequired: boolean }> {
  requireInstalledPack(pack);
  /* The 2027 EU pack has three lines, not the single identification
     number every other country pack still uses. A missing line fails
     closed. Customer due diligence also asks for the purpose and the
     source of funds, including when the customer is already verified. */
  if (pack.packId === EU_AMLR_PACK_ID) {
    const duty = euAmlrDuty({
      lines: await loadEuAmlrLines(client, pack.packId),
      amountHome,
      dealKind: deal.kind,
      cash: deal.cash,
      deskCashIdentify: await deskIdLine(client, actor.legalEntityId),
    });
    const stamp: ComplianceStamp = { rate: "1.000000000000", rateAt: null, source: null };
    if (duty.failClosed || (idStatus !== "verified" && duty.identify)) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        duty.failClosed
          ? "This desk's European Union rules are incomplete, so it cannot tell whether this customer needs to be identified."
          : "Authoritative compliance policy blocked posting.",
      );
    }
    if (duty.cdd && (!(deal.purpose ?? "").trim() || !(deal.sourceOfFunds ?? "").trim())) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "This deal needs customer due diligence, so it cannot be posted without its purpose and source of funds.",
      );
    }
    return { ...stamp, identificationRequired: false };
  }
  /* A euro line on a dinar book is decided here. A home-currency line,
     which is every seeded country pack except Serbia, is not. Canada
     keeps the split-pack gate below. */
  const foreign = await foreignCurrencyIdentification(
    client,
    pack,
    amountHome,
    deal.kind,
    deal.cash,
  );
  if (foreign.decided) {
    const stamp: ComplianceStamp = {
      rate: foreign.rate,
      rateAt: foreign.rateAt,
      source: foreign.source,
    };
    /* A missing rate fails closed for someone we have not identified.
       It does not, by itself, mean the amount crossed a line we could price. */
    const rateUnknown = foreign.rate == null && foreign.block;
    const desk = await deskIdLine(client, actor.legalEntityId);
    const deskHit = desk !== null && amountHome.gte(desk);
    const packHit = foreign.block;
    const identificationRequired = rateUnknown ? deskHit : packHit || deskHit;
    if (idStatus !== "verified" && (packHit || deskHit)) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "Authoritative compliance policy blocked posting.",
      );
    }
    return { ...stamp, identificationRequired };
  }
  const priced = pack.baseline
    ? await baselineIdentification(client, pack, amountHome, deal.kind, deal.cash)
    : { block: false, rate: "1.000000000000", rateAt: null, source: null };
  const stamp: ComplianceStamp = { rate: priced.rate, rateAt: priced.rateAt, source: priced.source };
  /* A verified customer has already satisfied the identity document.
     A split Canada pack still asks for the foreign-exchange ticket
     fields at its line, so that short-circuit cannot sit above the
     country check. The baseline has no such ticket rule. Australia v2
     does let a verified customer through: its own gate says the caller
     has already done that. */
  if (pack.packId === AU_V2_PACK_ID) {
    if (idStatus === "verified") return { ...stamp, identificationRequired: false };
    const judged = await australiaIdentification(
      client,
      actor,
      pack,
      amountHome,
      deal,
    );
    if (judged.block) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "Authoritative compliance policy blocked posting.",
      );
    }
    return {
      rate: judged.rate,
      rateAt: judged.rateAt,
      source: judged.source,
      identificationRequired: false,
    };
  }
  /* India does not use the single identification column for every kind
     of deal. A remittance is every deal. A walk-in foreign exchange is
     50,000 INR or more. A verified customer has already satisfied that
     duty. A desk number can only tighten the walk-in line. */
  if (pack.packId === INDIA_PACK_ID) {
    if (idStatus !== "verified") {
      const desk = await deskIdLine(client, actor.legalEntityId);
      if (indiaIdentificationRequired(amountHome, deal.kind, desk)) {
        throw new LedgerError(
          "COMPLIANCE_BLOCKED",
          "Authoritative compliance policy blocked posting.",
        );
      }
    }
    return { ...stamp, identificationRequired: false };
  }
  /* The Philippines does not use the single identification column with
     "at or above". Money changing and remittance are more than 5,000
     PHP. A bill, an electronic transfer, or a cheque is more than
     100,000 PHP. A missing row blocks. Other packs keep the gate below. */
  if (isPhilippinesPack(pack.packId)) {
    if (pack.homeCurrency.trim().toUpperCase() !== "PHP") {
      throw new LedgerError("COMPLIANCE_BLOCKED", PH_BOOK_MESSAGE);
    }
    if (idStatus !== "verified") {
      const desk = await deskIdLine(client, actor.legalEntityId);
      const row = await philippinesIdRow(client, pack.packId, deal.kind);
      if (identificationBlocks(amountHome, row, desk)) {
        throw new LedgerError(
          "COMPLIANCE_BLOCKED",
          "Authoritative compliance policy blocked posting.",
        );
      }
    }
    return { ...stamp, identificationRequired: false };
  }
  if (pack.baseline) {
    if (idStatus === "verified") return { ...stamp, identificationRequired: false };
    /* A missing or stale market rate already sets block. A desk's own
       tighter line, stored in home currency, can only add a refusal. */
    const desk = await deskIdLine(client, actor.legalEntityId);
    if (priced.block || (desk !== null && amountHome.gte(desk))) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "Authoritative compliance policy blocked posting.",
      );
    }
    return { ...stamp, identificationRequired: false };
  }
  /* pack-gb-v2 does not use the single identification column. The
     statute is one line per kind of deal, and a transfer is "more
     than", not "at or above". A verified customer has already
     satisfied that duty. See uk-mlr.ts. */
  if (pack.packId === UK_PACK_V2) {
    if (idStatus === "verified") return { ...stamp, identificationRequired: false };
    const block = await ukDueDiligenceBlocks(
      client,
      actor.legalEntityId,
      pack,
      amountHome,
      deal,
    );
    if (block) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "Authoritative compliance policy blocked posting.",
      );
    }
    return { ...stamp, identificationRequired: false };
  }
  /* pack-ae-v2 does not use the single identification column as the
     gate. Foreign exchange is AED 3,500 or more. A money transfer is
     every deal. A stored number cannot raise the 3,500 floor. A
     verified customer has already satisfied that duty. See
     uae-exchange.ts. */
  if (pack.packId === AE_PACK_V2) {
    if (idStatus === "verified") return { ...stamp, identificationRequired: false };
    const block = await aeDueDiligenceBlocks(
      client,
      actor.legalEntityId,
      pack,
      amountHome,
      deal,
    );
    if (block) {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "Authoritative compliance policy blocked posting.",
      );
    }
    return { ...stamp, identificationRequired: false };
  }
  const country = await countryIdentification(client, {
    legalEntityId: actor.legalEntityId,
    branchId: actor.branchId,
    pack,
    amountHome,
    verified: idStatus === "verified",
    deal,
  });
  if (country.split) {
    if (country.refusal) throw new LedgerError(country.refusal.code, country.refusal.message);
    return { ...stamp, identificationRequired: false };
  }
  const desk = await deskIdLine(client, actor.legalEntityId);
  const deskHit = desk !== null && amountHome.gte(desk);
  const line = await resolveIdThreshold(client, actor.legalEntityId, pack);
  if (line === null) {
    if (idStatus !== "verified") {
      throw new LedgerError(
        "COMPLIANCE_BLOCKED",
        "This desk has no identification threshold, so it cannot tell whether this customer needs to be identified. Set one in Settings, or ask your jurisdiction pack to be installed.",
      );
    }
    return { ...stamp, identificationRequired: deskHit };
  }
  const packHit = amountHome.gte(line);
  if (idStatus !== "verified" && (packHit || deskHit)) {
    throw new LedgerError(
      "COMPLIANCE_BLOCKED",
      "Authoritative compliance policy blocked posting.",
    );
  }
  return { ...stamp, identificationRequired: packHit || deskHit };
}

/* Purpose and source of funds, over a reporting line. A pack with no
   line still requires them, because "we could not tell whether this
   was reportable, so we asked for nothing" is not an answer. The
   United Kingdom v2 pack is the exception: the law has no large-cash
   report, and a zero on that column means exactly that. pack-ae-v2
   is the exception on a foreign exchange under AED 35,000: a zero
   reporting column means there is no cash report, not that every
   exchange needs the fields. A money transfer on that pack needs
   them at any amount. A number the desk types still binds. */
const NO_REPORTING_LINE =
  "This desk has no reporting threshold, so a deal cannot be posted without its purpose and source of funds. Set one in Settings, or ask your jurisdiction pack to be installed.";

export async function requirePurposeAndSource(
  client: pg.PoolClient,
  legalEntityId: string,
  pack: JurisdictionPack,
  amountHome: Decimal,
  purpose: string,
  sourceOfFunds: string,
  deal?: { kind: string },
): Promise<void> {
  if (purpose.trim() && sourceOfFunds.trim()) return;
  /* The resolved line, not the figure printed on the pack row. A
     baseline desk states 10,000 USD and posts in its own currency, so
     the comparison has to be the converted amount. pack-gb-v2 stores
     0, which this reader treats as no amount. */
  const line = await resolveReportThreshold(client, legalEntityId, pack);
  if (pack.packId === AE_PACK_V2) {
    const decision = aePurposeDecision(
      idKindForDeal(deal?.kind ?? "fx"),
      line,
      amountHome,
    );
    if (decision === "allow") return;
    throw new LedgerError(
      "COMPLIANCE_BLOCKED",
      "Authoritative compliance policy blocked posting.",
    );
  }
  const decision = purposeDecision(pack.packId, line, amountHome);
  if (decision === "allow") return;
  throw new LedgerError(
    "COMPLIANCE_BLOCKED",
    decision === "missing"
      ? NO_REPORTING_LINE
      : "Authoritative compliance policy blocked posting.",
  );
}

/* Purpose and source of funds once India's due-diligence line is met.
   A verified customer still has to give them. A remittance needs them
   at any amount. Other packs are untouched: their purpose check stays
   on the reporting line. */
export function assertIndiaPurpose(
  pack: JurisdictionPack,
  amountHome: Decimal,
  dealKind: string,
  purpose: string,
  sourceOfFunds: string,
): void {
  if (pack.packId !== INDIA_PACK_ID) return;
  if (!indiaPurposeRequired(amountHome, dealKind)) return;
  if (purpose.trim() && sourceOfFunds.trim()) return;
  throw new LedgerError("COMPLIANCE_BLOCKED", INDIA_PURPOSE_MESSAGE);
}

function assertIndiaSaleCash(
  pack: JurisdictionPack,
  from: string,
  to: string,
  inputAmount: Decimal,
): void {
  if (
    indiaSaleCashBlocked({
      packId: pack.packId,
      from,
      to,
      inputAmount,
      home: pack.homeCurrency,
    })
  ) {
    throw new LedgerError("COMPLIANCE_BLOCKED", INDIA_SALE_CASH_MESSAGE);
  }
}

/* Covered-transaction value, the cash-payout cap, the foreign-currency
   sale cap, and purpose once the deal is over 500,000 PHP. A verified
   customer still hits these. Other packs are untouched. Returns null
   when this is not a Philippines desk. */
async function philippinesExchangeGuard(
  client: pg.PoolClient,
  pack: JurisdictionPack,
  legs: {
    from: string;
    to: string;
    inputAmount: Decimal;
    outputAmount: Decimal;
    purpose: string;
    sourceOfFunds: string;
  },
): Promise<{ pesos: Decimal; rate: string; rateAt: Date | null } | null> {
  if (!isPhilippinesPack(pack.packId)) return null;
  if (pack.homeCurrency.trim().toUpperCase() !== "PHP") {
    throw new LedgerError("COMPLIANCE_BLOCKED", PH_BOOK_MESSAGE);
  }
  const valued = await philippinesDealPesos(client, legs);
  if (!valued) throw new LedgerError("COMPLIANCE_BLOCKED", PH_UNPRICED_MESSAGE);
  const sale = await philippinesFxSale(client, legs.from, legs.to, legs.outputAmount);
  if (sale === "over") throw new LedgerError("COMPLIANCE_BLOCKED", PH_SALE_BLOCK_MESSAGE);
  if (sale === "unpriced") throw new LedgerError("COMPLIANCE_BLOCKED", PH_SALE_UNPRICED_MESSAGE);
  const payout = await philippinesCashPayout(client, legs.to, legs.outputAmount);
  if (payout === "over") throw new LedgerError("COMPLIANCE_BLOCKED", PH_PAYOUT_BLOCK_MESSAGE);
  if (payout === "unpriced") throw new LedgerError("COMPLIANCE_BLOCKED", PH_PAYOUT_UNPRICED_MESSAGE);
  if (philippinesPurposeRequired(valued.pesos)) {
    if (!legs.purpose.trim() || !legs.sourceOfFunds.trim()) {
      throw new LedgerError("COMPLIANCE_BLOCKED", PH_PURPOSE_MESSAGE);
    }
  }
  return valued;
}

export class LedgerService {
  constructor(private readonly pool: pg.Pool, private readonly log?: AuditLogger) {}

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
    deal: IdentificationDeal,
  ) {
    return requireIdentification(client, actor, pack, amountHome, idStatus, deal);
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
    let committed = false;
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
      requireInstalledPack(pack);
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
      if (quote.reportSuspicion === true && pack.packId === "pack-rs-v1") {
        const named = await client.query(
          "SELECT name FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5",
          [quote.customerId, ...scope(actor).slice(0, 4)],
        );
        if (!named.rowCount)
          throw new LedgerError("CUSTOMER_NOT_FOUND", "Customer is not in the active workspace.");
        await holdSerbiaSuspicion(client, pack, actor, {
          reportSuspicion: true,
          customerId: quote.customerId,
          customerName: String(named.rows[0].name ?? ""),
          amount: quote.inputAmount,
          from: quote.from,
          to: quote.to,
        });
        await client.query("COMMIT");
        committed = true;
        throw new LedgerError("COMPLIANCE_BLOCKED", SERBIA_SUSPICION_HELD);
      }
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
      /* A client in a blocked jurisdiction stops the deal before
         identification. The code is SANCTIONS-STOP on every pack.
         Enhanced due diligence still demands full identification
         and a reason, whatever the amount. */
      applyDealScreen(
        await screenDeal(
          client,
          { tenantId: actor.tenantId, legalEntityId: actor.legalEntityId },
          { customerId: quote.customerId, dealKind: "exchange" },
        ),
        {
          idStatus: customer.rows[0].id_status,
          purpose: quote.purpose,
          sourceOfFunds: quote.sourceOfFunds,
        },
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
      /* Cash for a sale of foreign exchange, India only. The rupee the
         customer pays, not the fee. A purchase is not this check. */
      assertIndiaSaleCash(pack, quote.from, quote.to, input);
      /* Philippine limits use a peso leg, or a market rate. The board
         mid above is the shop's price. It is not the legal rate. */
      const phValue = await philippinesExchangeGuard(client, pack, {
        from: quote.from,
        to: quote.to,
        inputAmount: input,
        outputAmount: output,
        purpose: quote.purpose,
        sourceOfFunds: quote.sourceOfFunds,
      });
      const compliance = await this.requireIdentification(
        client,
        actor,
        pack,
        phValue ? phValue.pesos : inputHome,
        customer.rows[0].id_status,
        {
          kind: "exchange",
          cash: true,
          cashIn: true,
          customerId: quote.customerId,
          onBehalfOf: quote.thirdParty ? quote.thirdPartyName : null,
          purpose: quote.purpose,
          sourceOfFunds: quote.sourceOfFunds,
        },
      );
      if (phValue) {
        compliance.rate = phValue.rate;
        compliance.rateAt = phValue.rateAt;
      }
      const serbia = await serbiaExchangeFacts(
        client,
        pack,
        actor,
        {
          from: quote.from,
          to: quote.to,
          kind: "exchange",
          cash: true,
          customerName: String(customer.rows[0].name ?? ""),
          idStatus: customer.rows[0].id_status,
          rate: fixed(rate, 12),
        },
        compliance.identificationRequired,
        {
          identityNumber: quote.identityNumber,
          usdLargeNotes: quote.usdLargeNotes,
          usdNoteSerials: quote.usdNoteSerials,
        },
      );
      if (!serbia.ok) throw new LedgerError("COMPLIANCE_BLOCKED", serbia.message);
      /* Only this pack. A quote on any other pack posts without a
         purpose check here, the same as it did before. The 35,000
         line would be skipped if the real till (which posts a frozen
         quote) never asked. */
      if (pack.packId === AE_PACK_V2) {
        await requirePurposeAndSource(
          client,
          actor.legalEntityId,
          pack,
          inputHome,
          quote.purpose,
          quote.sourceOfFunds,
          { kind: "exchange" },
        );
      }
      assertIndiaPurpose(pack, inputHome, "exchange", quote.purpose, quote.sourceOfFunds);
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
            ...(serbia.receiptFacts?.side
              ? [`Exchange: ${serbia.receiptFacts.side} ${serbia.receiptFacts.basis}`]
              : []),
            ...(serbia.identityNumber ? [`JMBG or passport: ${serbia.identityNumber}`] : []),
            ...(serbia.noteSerials ? [`Note serials: ${serbia.noteSerials.join(", ")}`] : []),
          ],
        },
      };
      await client.query(
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,compliance_captured_by,compliance_captured_at,quote_id,market_mid,rate_board_publication_id,market_snapshot_id,rate_source_type,quote_override_id,posted_at,realized_pnl_home,cost_of_sale_home,deal_kind,received_instrument,disbursed_instrument,jurisdiction_pack_id,jurisdiction_pack_version,home_currency,compliance_threshold_rate,compliance_threshold_rate_at,cash_in_home,identity_number,note_serials,receipt_facts,compliance_threshold_rate_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44)",
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
          pack.packId,
          pack.version,
          home,
          compliance.rate,
          compliance.rateAt,
          /* Home value of what the customer paid, not the fee. Same
             figure the large-cash window will read back. */
          fixed(inputHome),
          serbia.identityNumber,
          serbia.noteSerials ? JSON.stringify(serbia.noteSerials) : null,
          serbia.receiptFacts ? JSON.stringify(serbia.receiptFacts) : null,
          compliance.source,
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
      committed = true;
      return response;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "40001") {
        throw new LedgerError("IDEMPOTENCY_IN_PROGRESS", "Retry the idempotent request.");
      }
      await recordSanctionsStop(this.pool, actor, error, this.log);
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
    let committed = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      await this.principal(client, actor, "transaction:post");
      await this.requireOpenTill(client, actor);
      /* Whether this pair may be traded is the jurisdiction's answer, not a
         constant. This used to demand CAD on one side, which is the pilot's
         limitation and not a rule anywhere. It has to be asked inside the
         transaction because the pack is read through the same client. */
      const pack = await resolvePack(client, actor.legalEntityId);
      requireInstalledPack(pack);
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
      const existing = await client.query(
        "SELECT response FROM ledger_idempotency WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4 AND till_id=$5 AND operation='post' AND idempotency_key=$6 FOR UPDATE",
        [...scope(actor), request.idempotencyKey],
      );
      if (existing.rowCount && existing.rows[0].response) {
        await client.query("COMMIT");
        committed = true;
        return existing.rows[0].response;
      }
      if (request.reportSuspicion === true && pack.packId === "pack-rs-v1") {
        const named = await client.query(
          "SELECT name FROM ledger_customers WHERE customer_id=$1 AND tenant_id=$2 AND legal_entity_id=$3 AND branch_id=$4 AND workspace_id=$5",
          [request.customerId, ...scope(actor).slice(0, 4)],
        );
        if (!named.rowCount)
          throw new LedgerError("CUSTOMER_NOT_FOUND", "Customer is not in the active workspace.");
        await holdSerbiaSuspicion(client, pack, actor, {
          reportSuspicion: true,
          customerId: request.customerId,
          customerName: String(named.rows[0].name ?? ""),
          amount: request.inputAmount,
          from: request.from,
          to: request.to,
        });
        await client.query("COMMIT");
        committed = true;
        throw new LedgerError("COMPLIANCE_BLOCKED", SERBIA_SUSPICION_HELD);
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
      applyDealScreen(
        await screenDeal(
          client,
          { tenantId: actor.tenantId, legalEntityId: actor.legalEntityId },
          { customerId: request.customerId, dealKind: "exchange" },
        ),
        {
          idStatus: customer.rows[0].id_status,
          purpose: request.purpose,
          sourceOfFunds: request.sourceOfFunds,
        },
      );
      const rows = await client.query(
        "SELECT currency,units_per_cad FROM ledger_rates WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3 AND workspace_id=$4",
        scope(actor).slice(0, 4),
      );
      const rates = new Map<string, Decimal>(
        rows.rows.map((row) => [
          String(row.currency),
          new Decimal(row.units_per_cad),
        ]),
      );
      /* Bound to locals rather than indexed four more times below. With
         `Currency` widened from a four-way union to a code, TypeScript
         started saying what was always true: a lookup by an arbitrary
         code can miss. The guard was already here and already correct —
         it just could not be seen through an index signature, and the
         arithmetic underneath it was running on values the compiler had
         been told could not be absent. */
      const fromRate = rates.get(request.from);
      const toRate = rates.get(request.to);
      if (!fromRate || !toRate)
        throw new LedgerError(
          "RATE_NOT_AVAILABLE",
          `This till has no rate for ${!fromRate ? request.from : request.to}.`,
        );
      const input = decimal(request.inputAmount, "0.01");
      const fee = decimal(request.feeCad, "0");
      const rate = toRate.div(fromRate).toDecimalPlaces(12);
      // Legacy direct posting has no commercial adjustment. Quote posting
      // supplies frozen customer rate and spread through postFrozenQuote.
      /* `units_per_cad` is the pilot's name for a rate against the book's
         own currency, kept because renaming a column is not free. The
         figure it produces is home currency, whatever the pack says home
         is — which is why it is no longer called `inputCad`. */
      const inputHome = input.div(fromRate).toDecimalPlaces(2);
      const output = input.mul(rate).toDecimalPlaces(2);
      const outputCad = output.div(toRate).toDecimalPlaces(2);
      const spread = inputHome.sub(outputCad).toDecimalPlaces(2);
      assertIndiaSaleCash(pack, request.from, request.to, input);
      const phValue = await philippinesExchangeGuard(client, pack, {
        from: request.from,
        to: request.to,
        inputAmount: input,
        outputAmount: output,
        purpose: request.purpose,
        sourceOfFunds: request.sourceOfFunds,
      });
      const compliance = await this.requireIdentification(
        client,
        actor,
        pack,
        phValue ? phValue.pesos : inputHome,
        customer.rows[0].id_status,
        {
          kind: "exchange",
          cash: true,
          cashIn: true,
          customerId: request.customerId,
          onBehalfOf: request.thirdParty ? request.thirdPartyName : null,
          purpose: request.purpose,
          sourceOfFunds: request.sourceOfFunds,
        },
      );
      if (phValue) {
        compliance.rate = phValue.rate;
        compliance.rateAt = phValue.rateAt;
      }
      const serbia = await serbiaExchangeFacts(
        client,
        pack,
        actor,
        {
          from: request.from,
          to: request.to,
          kind: "exchange",
          cash: true,
          customerName: String(customer.rows[0].name ?? ""),
          idStatus: customer.rows[0].id_status,
          rate: fixed(rate, 12),
        },
        compliance.identificationRequired,
        {
          identityNumber: request.identityNumber,
          usdLargeNotes: request.usdLargeNotes,
          usdNoteSerials: request.usdNoteSerials,
        },
      );
      if (!serbia.ok) throw new LedgerError("COMPLIANCE_BLOCKED", serbia.message);
      assertIndiaPurpose(pack, inputHome, "exchange", request.purpose, request.sourceOfFunds);
      /* The 2027 EU pack has no large-cash report, so an empty reporting
         line is not "purpose on every deal". Due diligence asks for it
         inside requireIdentification, and only when that line is hit.
         Every other pack, including the United Kingdom, the UAE, and
         India, goes through requirePurposeAndSource. India also asks
         at its own due-diligence line, above. A Philippines desk already
         applied "more than 500,000 PHP" in philippinesExchangeGuard.
         The generic test is "at or above", which would catch 500,000. */
      if (pack.packId !== EU_AMLR_PACK_ID && !isPhilippinesPack(pack.packId)) {
        await requirePurposeAndSource(
          client,
          actor.legalEntityId,
          pack,
          inputHome,
          request.purpose,
          request.sourceOfFunds,
          { kind: "exchange" },
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
            ...(serbia.receiptFacts?.side
              ? [`Exchange: ${serbia.receiptFacts.side} ${serbia.receiptFacts.basis}`]
              : []),
            ...(serbia.identityNumber ? [`JMBG or passport: ${serbia.identityNumber}`] : []),
            ...(serbia.noteSerials ? [`Note serials: ${serbia.noteSerials.join(", ")}`] : []),
          ],
        },
      };
      await client.query(
        "INSERT INTO ledger_transactions (transaction_id,transaction_ref,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,customer_id,actor_id,from_currency,to_currency,input_amount,output_amount,rate,fee_cad,spread_cad,purpose,source_of_funds,third_party,third_party_name,compliance_captured_by,compliance_captured_at,posted_at,deal_kind,received_instrument,disbursed_instrument,jurisdiction_pack_id,jurisdiction_pack_version,home_currency,compliance_threshold_rate,compliance_threshold_rate_at,cash_in_home,identity_number,note_serials,receipt_facts,compliance_threshold_rate_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)",
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
          pack.packId,
          pack.version,
          pack.homeCurrency,
          compliance.rate,
          compliance.rateAt,
          /* Home value of what the customer paid, not the fee. The
             large-cash window reads this column. The fee is a separate
             cash receipt and is not part of the exchange amount. */
          fixed(inputHome),
          serbia.identityNumber,
          serbia.noteSerials ? JSON.stringify(serbia.noteSerials) : null,
          serbia.receiptFacts ? JSON.stringify(serbia.receiptFacts) : null,
          compliance.source,
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
      committed = true;
      return response;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
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
      await recordSanctionsStop(this.pool, actor, error, this.log);
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
