/* ============================================================
   United Arab Emirates, pack-ae-v2.

   An exchange house under CBUAE Exchange Business Standards
   Chapter 16, and Cabinet Resolution No. 134 of 2025.

   pack-ae-v1 is left as it was published. This module is what a
   desk on v2 is judged by. A desk on v1 still uses the single
   identification column and the AED 55,000 figure stored as a
   cash report. That desk stays there until somebody opts in.

   A following desk (no identification number of its own):

     foreign exchange              AED 3,500 or more     identify
     one foreign exchange          AED 35,000 or more    purpose
                                   and source of funds
     remittance, electronic        any amount            identify,
     transfer                                            purpose,
                                                         and source
     virtual currency              no amount stated      identify

   The 35,000 line is a constant. The identification table holds
   one row per kind of deal, and that row is already the 3,500
   line. A second band does not fit. The 90 day sum in Standards
   16.9 and the 45 day sum in Standards 16.10 are not applied.
   See docs/UAE_PACK.md.

   Settings has one identification box. A number strictly below
   AED 3,500 tightens foreign exchange, and "at or above" is what
   the box means. A number at or above AED 3,500 is ignored. It
   cannot raise the floor. It also cannot loosen a money transfer:
   every transfer is identified, whatever the box says.

   There is no cash report. A blank reporting box does not demand
   purpose and source of funds on every foreign exchange. A number
   the desk types is its own policy, and that number does. The
   35,000 line does too, whether or not the box is blank.
   ============================================================ */
import Decimal from "decimal.js";
import type pg from "pg";
import { idKindForDeal } from "./compliance-gate.js";
import type { IdDealKind, JurisdictionPack } from "./jurisdiction.js";

export const AE_PACK_V1 = "pack-ae-v1";
export const AE_PACK_V2 = "pack-ae-v2";

/** Standards 16.8. One foreign exchange, at or above this, identification. */
export const AE_FX_CID = new Decimal("3500");

/**
 * Standards 16.9, the one-deal half. At or above this, purpose and
 * source of funds. The 90 day half is not this number.
 */
export const AE_FX_CDD_ONE_OFF = new Decimal("35000");

export type AeComparator = "gt" | "gte";

export type AeLine = {
  amount: Decimal;
  comparator: AeComparator;
};

/** What the transfer screen should print for a v2 desk. */
export type TransferDueDiligence = {
  /** Home-currency amount. Null with everyDeal means identify every transfer. */
  amount: string | null;
  comparator: AeComparator;
  everyDeal: boolean;
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

function asComparator(value: unknown): AeComparator | null {
  return value === "gt" || value === "gte" ? value : null;
}

/**
 * The foreign-exchange line after the desk's own number.
 *
 * A desk number raises nothing. It tightens only when it is strictly
 * below the statutory amount. AED 3,500 or more stays where the
 * Standards put it.
 */
export function aeOperatingLine(
  statutory: Decimal,
  statutoryComparator: AeComparator,
  desk: Decimal | null,
): AeLine {
  if (desk !== null && desk.isFinite() && desk.gt(0) && desk.lt(statutory)) {
    return { amount: desk, comparator: "gte" };
  }
  return { amount: statutory, comparator: statutoryComparator };
}

export function aeAmountHits(amount: Decimal, line: AeLine): boolean {
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
 * Whether this v2 deal needs the customer identified.
 *
 * A missing row, a missing or zero amount, a currency that is not
 * the book's, or a comparator the table does not allow all mean
 * identify. Zero is how this pack says "every money transfer".
 * A verified customer never reaches this: the caller returns first.
 */
export async function aeDueDiligenceBlocks(
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
  /* 0 is every deal. It is not a positive statutory amount, so the
     desk's own number cannot lift it. */
  if (!statutory || !comparator) return true;
  const currency = String(row.currency ?? "").trim().toUpperCase();
  if (currency !== pack.homeCurrency.trim().toUpperCase()) return true;

  const desk = await entityMoney(client, legalEntityId, "id_threshold");
  const line = aeOperatingLine(statutory, comparator, desk);
  return aeAmountHits(amountHome, line);
}

/**
 * The transfer line the till should print. everyDeal means any amount.
 */
export async function aeTransferDueDiligence(
  client: pg.PoolClient,
  pack: JurisdictionPack,
): Promise<TransferDueDiligence> {
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
    return { amount: null, comparator: "gte", everyDeal: true };
  }
  const statutory = positiveMoney(row?.threshold);
  const currency = String(row?.currency ?? "").trim().toUpperCase();
  if (!statutory || currency !== pack.homeCurrency.trim().toUpperCase()) {
    return { amount: null, comparator: "gte", everyDeal: true };
  }
  return {
    amount: statutory.toFixed(2),
    comparator: asComparator(row?.comparator) ?? "gte",
    everyDeal: false,
  };
}

/**
 * Whether a blank purpose and source of funds may post, on pack-ae-v2.
 *
 * `reportLine` is a number the desk typed, already resolved. Null
 * means the pack's blank cash report, which does not itself demand
 * the fields.
 *
 * A money transfer or an electronic transfer always demands them.
 * A foreign exchange demands them at AED 35,000 or more on this one
 * deal, and also at or above a number the desk typed.
 */
export function aePurposeDecision(
  kind: IdDealKind,
  reportLine: Decimal | null,
  amountHome: Decimal,
): "allow" | "cdd" {
  if (kind === "remittance" || kind === "eft" || kind === "virtual_currency") {
    return "cdd";
  }
  if (amountHome.gte(AE_FX_CDD_ONE_OFF)) return "cdd";
  if (reportLine !== null && amountHome.gte(reportLine)) return "cdd";
  return "allow";
}
