/* ============================================================
   What this desk reports at, and what it identifies at.

   Two places hold every one of these numbers:

     jurisdiction_packs.*    what the regulator requires
     legal_entities.*        what this desk actually operates at

   NULL on the entity is not a missing value. It means "follow the pack",
   which is where every desk starts and where it stays until somebody
   decides otherwise. Exactly the shape of `legal_entities.cost_method`
   (see cost-method.ts), and for the same reason: the pack proposes and
   the desk decides.

   The one asymmetry is what the two numbers mean to each other. A costing
   method that disagrees with the pack is just a different choice. A
   threshold that disagrees with the pack has a DIRECTION:

     tighter than the mandate   a deliberate business decision, usually
                                because a bank or an auditor asked. Not a
                                fault. Nothing here treats it as one.
     looser than the mandate    the desk failing to report things it is
                                legally obliged to report.

   That judgement is `posture` below, and it is computed here rather than
   in the browser because the browser was doing it against a two-entry
   table of its own invention — FINTRAC and FinCEN — while the database
   held six packs. A desk in Dubai was measured against Canada's numbers
   or against nothing at all.

   Like cost-method.ts, this module is deliberately free of the ledger's
   service and authorization imports: service.ts reads it on the posting
   path and anything pulled in here would close a cycle. Changing a
   threshold — which needs an actor, a permission and an audit row — lives
   in threshold-control.ts.

   See docs/DESK_THRESHOLDS.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { marketHomePerUnit, roundDownCents } from "./compliance-gate.js";
import { resolvePack, type JurisdictionPack } from "./jurisdiction.js";

/** Where a desk's own number stands against what its regulator requires. */
export type Posture =
  /** the desk has made no choice; the pack's number is the desk's number */
  | "following"
  /** the desk demands more of itself than the regulator does */
  | "stricter"
  /** the desk demands less of itself than the regulator does — a failure */
  | "looser"
  /** the desk chose the pack's exact number rather than deferring to it */
  | "matching"
  /** nothing can answer: no pack figure and no desk figure */
  | "unknown";

export type ThresholdSetting<T> = {
  /** what the desk actually operates at. Null when nothing can answer. */
  effective: T | null;
  /** the desk's own choice, or null where it is following the pack */
  deskChoice: T | null;
  /** what the pack requires, which is what null falls back to */
  packValue: T | null;
  posture: Posture;
};

export type DeskThresholds = {
  /** the currency every money figure here is stated in — the pack's */
  currency: string;
  packId: string;
  packName: string;
  jurisdiction: string;
  regulator: string;
  /** what the regulator calls the report the reporting line triggers */
  reportName: string;
  /** the line at or above which a deal must be reported */
  reportThreshold: ThresholdSetting<string>;
  /** the line at or above which the customer must be identified */
  idThreshold: ThresholdSetting<string>;
  /** The remittance identification line, in home currency.
      On the baseline this is 1,000 USD converted at the market snapshot,
      rounded down to the cent, and null when that rate is stale or missing.
      A country pack already states it in home currency. The desk's own
      identification line is `idThreshold`, not this one. */
  remittanceIdThreshold: ThresholdSetting<string>;
  /** the window several small deals by one person are summed over */
  aggregationHours: ThresholdSetting<number>;
  /** how long filed reports and their records are kept */
  retentionYears: ThresholdSetting<number>;
};

/* Which way "stricter" points, per number.

   For a money line, LOWER is stricter: a desk identifying at 1,000 asks
   more people for ID than one identifying at 3,000.

   For the aggregation window, LONGER is stricter: summing a person's cash
   over 72 hours catches sets of deals a 24-hour window lets through. This
   is the one that reads backwards at a glance, and getting it wrong would
   invert the alarm — telling a desk running a wider net that it was
   non-compliant, and saying nothing to one running a narrower one.

   For retention, LONGER is stricter, for the obvious reason. */
type Direction = "lower_is_stricter" | "higher_is_stricter";

function posture(
  desk: Decimal | null,
  pack: Decimal | null,
  direction: Direction,
): Posture {
  if (desk === null) return pack === null ? "unknown" : "following";
  if (pack === null) return "unknown";
  if (desk.eq(pack)) return "matching";
  const stricter =
    direction === "lower_is_stricter" ? desk.lt(pack) : desk.gt(pack);
  return stricter ? "stricter" : "looser";
}

/* A numeric column, or null. Never NaN, never a "null" string.

   Zero and below come back as null — "cannot say" — rather than as a
   threshold of nothing. A pack or a desk holding 0 is ambiguous in the
   worst possible way: it reads as "identify everybody" to one person and
   "no line stated" to the next, and the two behaviours are opposites at
   the gate. Refusing to guess sends it down the null path, which is loud
   and fixable, instead of silently picking one. */
function money(value: unknown): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

function count(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

const asMoneySetting = (
  desk: Decimal | null,
  pack: Decimal | null,
  direction: Direction,
): ThresholdSetting<string> => ({
  effective: (desk ?? pack)?.toFixed(2) ?? null,
  deskChoice: desk?.toFixed(2) ?? null,
  packValue: pack?.toFixed(2) ?? null,
  posture: posture(desk, pack, direction),
});

const asCountSetting = (
  desk: number | null,
  pack: number | null,
  direction: Direction,
): ThresholdSetting<number> => ({
  effective: desk ?? pack,
  deskChoice: desk,
  packValue: pack,
  posture: posture(
    desk === null ? null : new Decimal(desk),
    pack === null ? null : new Decimal(pack),
    direction,
  ),
});

/* The pack's remittance identification line, in the desk's home currency.
   Same conversion as the cash-exchange line: a USD figure times the newest
   market snapshot, rounded down to the cent. No fresh rate, no line.
   A line already in home currency does not need a snapshot. */
async function remittanceLine(
  client: pg.PoolClient,
  pack: JurisdictionPack,
  market: { rate: Decimal } | null,
): Promise<ThresholdSetting<string>> {
  const unset: ThresholdSetting<string> = {
    effective: null,
    deskChoice: null,
    packValue: null,
    posture: "unknown",
  };
  if (!pack.available || !pack.packId) return unset;
  let row: { threshold?: unknown; currency?: unknown } | undefined;
  try {
    const found = await client.query(
      `SELECT threshold, currency
         FROM jurisdiction_id_thresholds
        WHERE pack_id = $1 AND deal_kind = 'remittance'`,
      [pack.packId],
    );
    row = found.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return unset;
    throw error;
  }
  const amount = money(row?.threshold);
  if (!amount) return unset;
  const currency = String(row?.currency ?? "").trim().toUpperCase();
  const home = pack.homeCurrency.trim().toUpperCase();
  let converted: Decimal | null = null;
  if (currency && currency === home) converted = amount;
  else if (currency === "USD" && market) converted = roundDownCents(amount.mul(market.rate));
  if (!converted) return unset;
  const value = converted.toFixed(2);
  return { effective: value, deskChoice: null, packValue: value, posture: "following" };
}

/**
 * Every threshold this desk operates under, resolved, inside the caller's
 * transaction.
 *
 * Read per use rather than cached, for the same reason the pack and the
 * costing method are: it is one small indexed read, and a stale answer
 * would let a deal past a line the desk had already tightened — a worse
 * thing to be wrong about than a query is to spend.
 */
export async function readDeskThresholds(
  client: pg.PoolClient,
  legalEntityId: string,
  /* The pack, where the caller has already resolved one. The posting path
     has: it reads the pack before anything else to learn the home currency,
     and re-reading it here would cost a second query on the hot path for an
     answer that cannot have changed inside the same transaction. */
  resolved?: JurisdictionPack,
): Promise<DeskThresholds> {
  const pack = resolved ?? (await resolvePack(client, legalEntityId));
  const found = await client.query(
    `SELECT e.report_threshold, e.id_threshold, e.aggregation_hours,
            e.retention_years, p.pack_id AS joined_pack_id,
            p.aggregation_hours AS pack_aggregation_hours,
            p.retention_years AS pack_retention_years
       FROM legal_entities e
       LEFT JOIN jurisdiction_packs p ON p.pack_id = e.jurisdiction_pack_id
      WHERE e.id = $1`,
    [legalEntityId],
  );
  const row = found.rows[0] ?? {};
  /* The entity row can have no pack id while the resolver has already
     fallen through to the baseline. That is not the same as a pack whose
     hour window is NULL. Hong Kong stores NULL on purpose: deals that
     appear to be linked are not summed here, and 24 would be a different
     rule. A missed join must still read the pack the resolver named,
     which for the baseline is 24. */
  let packAggregationHours = row.pack_aggregation_hours;
  if (pack.available && pack.packId && row.joined_pack_id == null) {
    const named = await client.query(
      `SELECT aggregation_hours FROM jurisdiction_packs WHERE pack_id = $1`,
      [pack.packId],
    );
    packAggregationHours = named.rows[0]?.aggregation_hours ?? null;
  }
  /* A baseline pack states its dollar lines in the desk's currency, at
     the same market rate the posting gate uses, rounded down to the cent.
     No fresh rate: the lines are unset, and identification is required. */
  const baselineForeign =
    pack.baseline && pack.homeCurrency.trim().toUpperCase() !== "USD";
  const market = baselineForeign
    ? await marketHomePerUnit(client, "USD", pack.homeCurrency)
    : { rate: new Decimal(1), rateAt: null };
  const packMoney = (raw: unknown): Decimal | null => {
    const amount = money(raw);
    if (!baselineForeign) return amount;
    if (!market || !amount) return null;
    return roundDownCents(amount.mul(market.rate));
  };
  const moneyLine = (deskRaw: unknown, packRaw: unknown) =>
    baselineForeign && !market
      ? {
          effective: null,
          deskChoice: money(deskRaw)?.toFixed(2) ?? null,
          packValue: null,
          posture: "unknown" as const,
        }
      : asMoneySetting(money(deskRaw), packMoney(packRaw), "lower_is_stricter");
  const remittanceIdThreshold = await remittanceLine(client, pack, market);
  return {
    currency: pack.homeCurrency,
    packId: pack.packId,
    packName: pack.name,
    jurisdiction: pack.jurisdiction,
    regulator: pack.regulator,
    reportName: pack.reportName,
    reportThreshold: moneyLine(row.report_threshold, pack.reportThreshold),
    idThreshold: moneyLine(row.id_threshold, pack.idThreshold),
    remittanceIdThreshold,
    aggregationHours: asCountSetting(
      /* NULL on the pack is a real answer: this country has no hour
         window. Do not invent 24, and do not let a desk choice invent
         one either. Hong Kong keeps no hour window. A pack that still
         stores 24, which is every pack shipped before this one, still
         reads 24. A desk with no pack at all does not get a number
         from the pack side. */
      pack.available && count(packAggregationHours) == null
        ? null
        : count(row.aggregation_hours),
      pack.available ? count(packAggregationHours) : null,
      "higher_is_stricter",
    ),
    retentionYears: asCountSetting(
      count(row.retention_years),
      pack.available ? (count(row.pack_retention_years) ?? 5) : null,
      "higher_is_stricter",
    ),
  };
}

/**
 * The line at or above which this desk must identify the customer, in the
 * currency the pack keeps its books in — and null when nothing can say.
 *
 * ---- null is not zero, and it is not infinity ----
 *
 * The posting path used to compare against a hardcoded 3,000 in a variable
 * called `inputCad`, so a British desk with a 1,000 line and a UAE desk
 * with a 3,500 one both got Canada's number. Resolving it properly means
 * accepting that the resolution can come back with nothing: an entity
 * pointing at a pack that was never installed, or a row created by a path
 * that has not been taught about any of this.
 *
 * A gate that never fires clears deals nobody checked. A gate that always
 * fires stops a desk trading. Neither is acceptable as a blanket answer,
 * so the caller does not get one — it gets `null`, and the posting path
 * turns that into a refusal ONLY for a customer who is not already
 * identified. See the note at the call site in service.ts: a verified
 * customer satisfies every possible value of a threshold nobody can state,
 * so there is nothing to be unsure about and the desk keeps trading. An
 * unverified one is precisely the case the gate exists for, and "we could
 * not work out whether ID was needed, so it wasn't" is not an answer
 * anybody can give a regulator.
 *
 * This is the same rule the browser follows for the reporting line —
 * `overReportingLimit` in os-src/cdos-base.jsx returns null rather than
 * false, because a screen that turns "cannot say" into "cleared" has
 * quietly passed a deal nobody checked.
 */
export async function resolveIdThreshold(
  client: pg.PoolClient,
  legalEntityId: string,
  resolved?: JurisdictionPack,
): Promise<Decimal | null> {
  const thresholds = await readDeskThresholds(client, legalEntityId, resolved);
  const value = thresholds.idThreshold.effective;
  return value === null ? null : new Decimal(value);
}

/**
 * The line at or above which a deal must be reported, in the pack's
 * currency, or null when nothing can say. Same rule as above.
 */
export async function resolveReportThreshold(
  client: pg.PoolClient,
  legalEntityId: string,
  resolved?: JurisdictionPack,
): Promise<Decimal | null> {
  const thresholds = await readDeskThresholds(client, legalEntityId, resolved);
  const value = thresholds.reportThreshold.effective;
  return value === null ? null : new Decimal(value);
}

export type { JurisdictionPack };
