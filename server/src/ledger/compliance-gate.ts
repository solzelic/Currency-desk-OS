/* The international baseline states its identification lines in US dollars.
   A country pack already states them in the currency the book is kept in.
   This file turns a USD line into that home currency, using the newest
   market snapshot — the same CAD-per-unit table the rate sync stores —
   and never a mid the shop typed onto its board. */
import Decimal from "decimal.js";
import type pg from "pg";
import type { IdDealKind, JurisdictionPack } from "./jurisdiction.js";

export type ComplianceStamp = {
  /** Home-currency units per 1 unit of the threshold currency. Null when
      no fresh market rate was available. "1" when no conversion was needed. */
  rate: string | null;
  /** When the market snapshot was fetched. Null when none was used. */
  rateAt: Date | null;
};

const IDENTITY: ComplianceStamp = { rate: "1.000000000000", rateAt: null };
const UNPRICED: ComplianceStamp = { rate: null, rateAt: null };

export function idKindForDeal(dealKind: string): IdDealKind {
  if (
    dealKind === "remittance" ||
    dealKind === "remittance_send" ||
    dealKind === "remittance_receive" ||
    dealKind === "money_order"
  ) {
    return "remittance";
  }
  if (dealKind === "eft" || dealKind === "bill_payment") return "eft";
  if (dealKind === "virtual_currency") return "virtual_currency";
  return "fx";
}

/** CAD per 1 unit. CAD itself is 1, and the snapshot does not store it. */
export function cadPerUnit(mids: Record<string, unknown>, code: string): Decimal | null {
  const currency = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  if (currency === "CAD") return new Decimal(1);
  const raw = mids[currency];
  if (raw == null || raw === "") return null;
  try {
    const parsed = new Decimal(String(raw));
    return parsed.isFinite() && parsed.gt(0) ? parsed : null;
  } catch {
    return null;
  }
}

/** Home-currency units per 1 unit of `unit`, from a CAD-per-unit snapshot. */
export function homePerUnit(
  mids: Record<string, unknown>,
  unit: string,
  home: string,
): Decimal | null {
  const perUnit = cadPerUnit(mids, unit);
  const perHome = cadPerUnit(mids, home);
  if (!perUnit || !perHome) return null;
  return perUnit.div(perHome);
}

function hits(amount: Decimal, line: Decimal, comparator: string): boolean {
  return comparator === "gt" ? amount.gt(line) : amount.gte(line);
}

function missingTable(error: unknown): boolean {
  return (error as { code?: string }).code === "42P01";
}

/** The home-currency line, rounded down to the cent. A fraction of a cent
    still requires identification: the till and the gate share this cut. */
export function roundDownCents(amount: Decimal): Decimal {
  return amount.toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

/** Home per 1 unit of `unit` from the newest market snapshot.
    Same currency is 1 and does not read the table. Missing, stale, or
    short a mid comes back null — the caller fails closed. */
export async function marketHomePerUnit(
  client: pg.PoolClient,
  unit: string,
  home: string,
): Promise<{ rate: Decimal; rateAt: Date | null } | null> {
  const unitCode = unit.trim().toUpperCase();
  const homeCode = home.trim().toUpperCase();
  if (unitCode && unitCode === homeCode) return { rate: new Decimal(1), rateAt: null };
  let latest: { mids: Record<string, unknown>; fetched_at: Date; fresh: boolean } | undefined;
  try {
    const snap = await client.query(
      `SELECT mids, fetched_at,
              (fetched_at >= now() - interval '24 hours') AS fresh
         FROM market_rates
        ORDER BY fetched_at DESC
        LIMIT 1`,
    );
    latest = snap.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    return null;
  }
  if (!latest || latest.fresh !== true) return null;
  const rate = homePerUnit(latest.mids ?? {}, unitCode, homeCode);
  if (!rate) return null;
  return { rate, rateAt: new Date(latest.fetched_at) };
}

/**
 * Whether this baseline deal needs identification, and the market rate
 * that decision used.
 *
 * A home currency that already matches the line needs no snapshot, so a
 * USD desk is not refused just because nobody has pulled rates. Anything
 * else uses the newest snapshot. Missing, stale (older than 24 hours),
 * or short a mid means identify every deal.
 */
export async function baselineIdentification(
  client: pg.PoolClient,
  pack: JurisdictionPack,
  amountHome: Decimal,
  dealKind: string,
  cash: boolean,
): Promise<ComplianceStamp & { block: boolean }> {
  if (!pack.baseline) return { block: false, ...IDENTITY };

  let row: Record<string, unknown> | undefined;
  try {
    const found = await client.query(
      `SELECT threshold, currency, comparator, cash_only
         FROM jurisdiction_id_thresholds
        WHERE pack_id = $1 AND deal_kind = $2`,
      [pack.packId, idKindForDeal(dealKind)],
    );
    row = found.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    /* No identification table at all. Fail closed: an unverified
       customer is identified on every deal, and no rate is invented. */
    return { block: true, ...UNPRICED };
  }
  if (!row) return { block: true, ...UNPRICED };
  if (row.cash_only === true && !cash) return { block: false, ...IDENTITY };

  const raw = row.threshold;
  if (raw == null || raw === "") return { block: true, ...UNPRICED };
  let threshold: Decimal;
  try {
    threshold = new Decimal(String(raw));
  } catch {
    return { block: true, ...UNPRICED };
  }
  if (!threshold.isFinite() || threshold.isNegative()) return { block: true, ...UNPRICED };
  const comparator = String(row.comparator || "gte");
  if (threshold.isZero()) {
    return { block: hits(amountHome, new Decimal(0), comparator), ...IDENTITY };
  }

  const currency = String(row.currency ?? "").trim().toUpperCase();
  if (currency === pack.homeCurrency) {
    return { block: hits(amountHome, threshold, comparator), ...IDENTITY };
  }

  const market = await marketHomePerUnit(client, currency, pack.homeCurrency);
  if (!market) return { block: true, ...UNPRICED };
  return {
    block: hits(amountHome, roundDownCents(threshold.mul(market.rate)), comparator),
    rate: market.rate.toDecimalPlaces(12).toFixed(12),
    rateAt: market.rateAt,
  };
}
