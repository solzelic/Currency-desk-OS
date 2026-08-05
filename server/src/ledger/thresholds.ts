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
            e.retention_years, p.aggregation_hours AS pack_aggregation_hours,
            p.retention_years AS pack_retention_years
       FROM legal_entities e
       LEFT JOIN jurisdiction_packs p ON p.pack_id = e.jurisdiction_pack_id
      WHERE e.id = $1`,
    [legalEntityId],
  );
  const row = found.rows[0] ?? {};
  return {
    currency: pack.homeCurrency,
    packId: pack.packId,
    packName: pack.name,
    jurisdiction: pack.jurisdiction,
    regulator: pack.regulator,
    reportName: pack.reportName,
    reportThreshold: asMoneySetting(
      money(row.report_threshold),
      money(pack.reportThreshold),
      "lower_is_stricter",
    ),
    idThreshold: asMoneySetting(
      money(row.id_threshold),
      money(pack.idThreshold),
      "lower_is_stricter",
    ),
    aggregationHours: asCountSetting(
      count(row.aggregation_hours),
      /* The pack's own column when the entity actually points at a pack,
         and the pilot's 24 when `resolvePack` had to fall back — an entity
         with no pack row has no pack column to read. */
      count(row.pack_aggregation_hours) ?? 24,
      "higher_is_stricter",
    ),
    retentionYears: asCountSetting(
      count(row.retention_years),
      count(row.pack_retention_years) ?? 5,
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
