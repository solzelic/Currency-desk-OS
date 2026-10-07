/* The National Bank of Serbia official middle rate for one calendar day
   in Europe/Belgrade.

   Statutory euro lines on the Serbia pack read this table and nothing
   else. `market_rates` is the shop's board feed. It is not this rate,
   and this module does not query it.

   A row is how many units of `quote_currency` equal one unit of
   `base_currency` on `rate_date`. For the Serbia book that is dinars
   per one euro. The posting gate uses the row whose rate_date is today
   in Belgrade. A row for another day is not today's rate, and there is
   no fallback to yesterday.

   Nothing here fetches the National Bank. A rate is on file only when
   a row has been stored. No row for today means the euro line is
   unpriced: an unidentified customer is refused, and the desk does not
   claim the euro line was met. */
import Decimal from "decimal.js";
import type pg from "pg";

export type NbsMiddle = {
  /** Quote currency per 1 unit of the base currency. Dinars per 1 euro. */
  rate: Decimal;
  /** When this row was stored, not when the bank published it. */
  rateAt: Date;
};

function missingTable(error: unknown): boolean {
  return (error as { code?: string }).code === "42P01";
}

/** Home per 1 unit of `unit` from the NBS middle rate for today in Belgrade.
    Missing table, missing row, wrong day, or a rate that is not a positive
    decimal comes back null. The caller fails closed. */
export async function nbsMiddleHomePerUnit(
  client: pg.PoolClient,
  unit: string,
  home: string,
): Promise<NbsMiddle | null> {
  const base = unit.trim().toUpperCase();
  const quote = home.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) return null;
  if (base === quote) return null;
  let row: { middle_rate?: unknown; fetched_at?: unknown } | undefined;
  try {
    const found = await client.query(
      `SELECT middle_rate, fetched_at
         FROM nbs_middle_rates
        WHERE btrim(base_currency) = $1
          AND btrim(quote_currency) = $2
          AND rate_date = (timezone('Europe/Belgrade', now()))::date`,
      [base, quote],
    );
    row = found.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    return null;
  }
  if (!row || row.middle_rate == null || row.middle_rate === "") return null;
  try {
    const rate = new Decimal(String(row.middle_rate));
    if (!rate.isFinite() || !rate.gt(0)) return null;
    const rateAt = row.fetched_at instanceof Date
      ? row.fetched_at
      : new Date(String(row.fetched_at));
    if (Number.isNaN(rateAt.getTime())) return null;
    return { rate, rateAt };
  } catch {
    return null;
  }
}
