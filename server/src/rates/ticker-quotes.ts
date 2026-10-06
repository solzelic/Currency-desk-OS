/* The tape quotes every currency in the desk's own money.

   market_rates stores Canadian dollars per one unit. A dinar desk's
   board is already dinars per unit, and the tape was mixing the two:
   USD 108.80 beside a change computed from 1.36. Both sides of a
   change, and every price on the tape, are home per unit:

     home_per_unit = CAD_per_unit / CAD_per_home

   The home currency is not a row on its own tape. When the snapshot
   cannot price the home currency, nothing here is converted — the
   caller shows the published board and no change, rather than a
   Canadian figure. Canada is the identity case: CAD per home is 1,
   so the mids stay Canadian dollars per unit. */
import Decimal from "decimal.js";
import { cadPerUnit } from "../ledger/compliance-gate.js";
import { INDICATIVE_PER_CAD } from "./starting-board.js";

export type TickerQuote = {
  code: string;
  /** Home-currency units per 1 unit, six decimal places. */
  mid: string;
  /** Percent move of the live mid against the indicative mid. Null when
      the snapshot has no print for this currency. */
  chg: string | null;
};

export function quoteHomeMarket(
  homeRaw: string,
  market: Record<string, unknown> | null,
): { priced: boolean; quotes: TickerQuote[] } {
  const home = String(homeRaw || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(home)) return { priced: false, quotes: [] };
  const mids = market ?? {};
  const perHome = home === "CAD" ? new Decimal(1) : cadPerUnit(mids, home);
  if (!perHome) return { priced: false, quotes: [] };

  const codes: string[] = [];
  for (const code of Object.keys(INDICATIVE_PER_CAD)) codes.push(code);
  for (const raw of Object.keys(mids)) {
    const code = raw.trim().toUpperCase();
    if (/^[A-Z]{3}$/.test(code) && !codes.includes(code)) codes.push(code);
  }
  if (home !== "CAD" && !codes.includes("CAD")) codes.unshift("CAD");

  const quotes: TickerQuote[] = [];
  for (const code of codes) {
    if (code === home) continue;
    const perCad = INDICATIVE_PER_CAD[code];
    const indicative = perCad
      ? new Decimal(1).div(String(perCad))
      : code === "CAD"
        ? new Decimal(1)
        : null;
    const live = cadPerUnit(mids, code);
    const displayCad = live ?? indicative;
    if (!displayCad) continue;
    const mid = displayCad.div(perHome);
    const chg = live && indicative && indicative.gt(0)
      ? live.minus(indicative).div(indicative).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
      : null;
    quotes.push({ code, mid: mid.toFixed(6), chg });
  }
  return { priced: true, quotes };
}
