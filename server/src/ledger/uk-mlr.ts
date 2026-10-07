/* ============================================================
   United Kingdom, pack-gb-v2.

   The Money Laundering Regulations 2017, as amended by SI 2026/621,
   for a bureau de change / money service business, plus the
   suspicious-activity duty in the Proceeds of Crime Act 2002 s.330.

   pack-gb-v1 is left as it was published. This module is what a desk
   on v2 is judged by. A desk on v1 still uses the single
   identification column, which is stricter than the statute and is
   that desk's installed pack until somebody opts in.

   A following desk (no identification number of its own):

     foreign exchange, virtual currency   £12,000 or more   (gte)
     remittance, electronic transfer       more than £800    (gt)

   Settings has one identification box. A number strictly below the
   statutory amount for that kind of deal tightens that kind, and
   "at or above" is what the box means. A number at or above the
   statutory amount is ignored. £12,000 or more is a hard floor for
   foreign exchange and virtual currency. More than £800 is a hard
   floor for a transfer. Neither floor can be raised.

   There is no large-cash report. A blank reporting box does not
   demand purpose and source of funds on every deal. A number the
   desk types is its own policy, and that number does.

   See docs/UK_PACK.md.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { idKindForDeal } from "./compliance-gate.js";
import type { IdDealKind, JurisdictionPack } from "./jurisdiction.js";

export const UK_PACK_V1 = "pack-gb-v1";
export const UK_PACK_V2 = "pack-gb-v2";

export type UkComparator = "gt" | "gte";

export type UkLine = {
  amount: Decimal;
  comparator: UkComparator;
};

/** The line a transfer screen should use, already resolved. */
export type TransferDueDiligence = {
  /** Home-currency amount. Null means the line could not be read, so identify. */
  amount: string | null;
  comparator: UkComparator;
};

function positiveMoney(value: unknown): Decimal | null {
  if (value == null || value === "") return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

function asComparator(value: unknown): UkComparator | null {
  return value === "gt" || value === "gte" ? value : null;
}

/**
 * The line this kind of deal is judged against, after the desk's own
 * identification number.
 *
 * `desk` null means the desk is following the pack. A non-positive
 * desk number is treated the same way: zero is not a line.
 *
 * A desk number raises nothing. It tightens a line only when it is
 * strictly below that line. £12,000 or more for an occasional
 * transaction, and more than £800 for a transfer, stay where the
 * statute put them.
 */
export function ukOperatingLine(
  _kind: IdDealKind,
  statutory: Decimal,
  statutoryComparator: UkComparator,
  desk: Decimal | null,
): UkLine {
  if (desk !== null && desk.isFinite() && desk.gt(0) && desk.lt(statutory)) {
    return { amount: desk, comparator: "gte" };
  }
  return { amount: statutory, comparator: statutoryComparator };
}

export function ukAmountHits(amount: Decimal, line: UkLine): boolean {
  return line.comparator === "gt" ? amount.gt(line.amount) : amount.gte(line.amount);
}

function missingTable(error: unknown): boolean {
  return (error as { code?: string }).code === "42P01";
}

async function entityMoney(
  client: pg.PoolClient,
  legalEntityId: string,
  column: "id_threshold" | "report_threshold",
): Promise<Decimal | null> {
  const found = await client.query(
    `SELECT ${column} AS amount FROM legal_entities WHERE id=$1`,
    [legalEntityId],
  );
  return positiveMoney(found.rows[0]?.amount);
}

/**
 * Whether this v2 deal needs customer due diligence.
 *
 * A missing row, a missing amount, a currency that is not the book's,
 * or a comparator the table does not allow all mean identify. A
 * verified customer never reaches this: the caller returns first.
 */
export async function ukDueDiligenceBlocks(
  client: pg.PoolClient,
  legalEntityId: string,
  pack: JurisdictionPack,
  amountHome: Decimal,
  deal: { kind: string; cash: boolean },
): Promise<boolean> {
  const kind = idKindForDeal(deal.kind);
  let row: Record<string, unknown> | undefined;
  try {
    const found = await client.query(
      `SELECT threshold, currency, comparator, cash_only
         FROM jurisdiction_id_thresholds
        WHERE pack_id = $1 AND deal_kind = $2`,
      [pack.packId, kind],
    );
    row = found.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    return true;
  }
  if (!row) return true;
  if (row.cash_only === true && !deal.cash) return false;

  const statutory = positiveMoney(row.threshold);
  const comparator = asComparator(row.comparator);
  if (!statutory || !comparator) return true;
  const currency = String(row.currency ?? "").trim().toUpperCase();
  if (currency !== pack.homeCurrency.trim().toUpperCase()) return true;

  const desk = await entityMoney(client, legalEntityId, "id_threshold");
  const line = ukOperatingLine(kind, statutory, comparator, desk);
  return ukAmountHits(amountHome, line);
}

/**
 * The transfer line the till should print, for a v2 desk.
 * Null amount means identify every transfer.
 */
export async function ukTransferDueDiligence(
  client: pg.PoolClient,
  legalEntityId: string,
  pack: JurisdictionPack,
): Promise<TransferDueDiligence> {
  const kind: IdDealKind = "remittance";
  let row: Record<string, unknown> | undefined;
  try {
    const found = await client.query(
      `SELECT threshold, currency, comparator
         FROM jurisdiction_id_thresholds
        WHERE pack_id = $1 AND deal_kind = 'remittance'`,
      [pack.packId],
    );
    row = found.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    return { amount: null, comparator: "gt" };
  }
  const statutory = positiveMoney(row?.threshold);
  const comparator = asComparator(row?.comparator);
  const currency = String(row?.currency ?? "").trim().toUpperCase();
  if (!statutory || !comparator || currency !== pack.homeCurrency.trim().toUpperCase()) {
    return { amount: null, comparator: "gt" };
  }
  const desk = await entityMoney(client, legalEntityId, "id_threshold");
  const line = ukOperatingLine(kind, statutory, comparator, desk);
  return { amount: line.amount.toFixed(2), comparator: line.comparator };
}

/**
 * Whether a blank purpose and source of funds may post.
 *
 * `line` is the reporting figure already resolved into the desk's
 * home currency, including a baseline conversion. Null means that
 * resolution named no amount.
 *
 * On pack-gb-v2, no amount is the statute: there is no large-cash
 * report, so the fields are not required. On every other pack, no
 * amount is a broken desk and the fields are required. A number,
 * whether the pack's or one the desk typed, binds at or above it.
 */
export function purposeDecision(
  packId: string,
  line: Decimal | null,
  amountHome: Decimal,
): "allow" | "missing" | "over" {
  if (line === null) return packId === UK_PACK_V2 ? "allow" : "missing";
  return amountHome.gte(line) ? "over" : "allow";
}
