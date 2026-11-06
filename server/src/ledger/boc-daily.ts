/* The Bank of Canada's daily rate for a currency, as the gate reads it
   (CD-146, GitHub #631). Beside nbs-middle.ts, and shaped like it.

   The latest published rate is the rate in effect (Compliance, 3 Nov).
   It is flagged stale when its date is older than the last business
   day in Toronto: the feed failed, or the bank stopped publishing that
   currency. The caller decides what a stale rate means; this says only
   that it is. The last business day is the last weekday; a rate dated
   the day before a bank holiday reads as stale the day after it, which
   is a known limit and errs toward saying so.

   A book not kept in dollars has no Bank of Canada rate. The dollar
   itself is one. Missing table or row comes back null, and the caller
   fails closed. Nothing here reads market_rates, which is the board. */
import Decimal from "decimal.js";
import type pg from "pg";

export type BocDaily = {
  /** Canadian dollars per 1 unit of the currency. */
  rate: Decimal;
  /** The bank's date for the rate, YYYY-MM-DD. */
  rateDate: string;
  /** When the row was stored, not when the bank published it. */
  rateAt: Date | null;
  /** Older than the last business day in Toronto. */
  stale: boolean;
  source: "boc_daily";
};

function missingTable(error: unknown): boolean {
  return (error as { code?: string }).code === "42P01";
}

export async function bocHomePerUnit(
  client: pg.PoolClient,
  unit: string,
  home: string,
): Promise<BocDaily | null> {
  const currency = unit.trim().toUpperCase();
  if (home.trim().toUpperCase() !== "CAD" || !/^[A-Z]{3}$/.test(currency)) return null;
  if (currency === "CAD") {
    const today = await client.query("SELECT (timezone('America/Toronto', now()))::date::text AS d");
    return { rate: new Decimal(1), rateDate: String(today.rows[0]?.d ?? ""), rateAt: null, stale: false, source: "boc_daily" };
  }
  let row: { rate_date?: unknown; cad_per_unit?: unknown; fetched_at?: unknown; stale?: unknown } | undefined;
  try {
    /* The last business day: yesterday, or Friday from a Saturday, a
       Sunday or a Monday (DOW: 0 is Sunday). */
    const found = await client.query(
      `WITH toronto AS (SELECT (timezone('America/Toronto', now()))::date AS today)
       SELECT rate_date::text AS rate_date, cad_per_unit, fetched_at,
              rate_date < (SELECT today - CASE EXTRACT(DOW FROM today)::int WHEN 1 THEN 3 WHEN 0 THEN 2 ELSE 1 END FROM toronto) AS stale
         FROM boc_daily_rates
        WHERE currency = $1
        ORDER BY rate_date DESC
        LIMIT 1`,
      [currency],
    );
    row = found.rows[0];
  } catch (error) {
    if (!missingTable(error)) throw error;
    return null;
  }
  if (!row || row.cad_per_unit == null || row.cad_per_unit === "") return null;
  try {
    const rate = new Decimal(String(row.cad_per_unit));
    if (!rate.isFinite() || !rate.gt(0)) return null;
    const rateAt = row.fetched_at instanceof Date ? row.fetched_at : new Date(String(row.fetched_at));
    return {
      rate,
      rateDate: String(row.rate_date),
      rateAt: Number.isNaN(rateAt.getTime()) ? null : rateAt,
      stale: row.stale === true,
      source: "boc_daily",
    };
  } catch {
    return null;
  }
}
