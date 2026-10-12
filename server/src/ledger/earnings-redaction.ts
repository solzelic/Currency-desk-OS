/* Shop earnings, P&L, cost of sale, the booked spread, unrealized
   P&L, cost basis, market value, the market mid, and the per-teller
   money split. A teller can post a deal. These reads do not hand the
   book's take back to a role that cannot close the day and cannot
   read the earnings report.

   Cost basis and market value go too. Leaving both, and leaving off
   only the unrealized gain, is one subtraction. The unit cost and the
   market unit go with them, because quantity times either one is the
   same pair of figures. The market mid goes, because the amounts on
   the deal and the mid the spread was booked against are the spread.

   The customer-facing fee stays. The customer was charged it: the
   deal's feeCad, the cheque's feeAmount, the receipt line, and the
   day's fee total. The per-teller feesHome is the split, so that one
   goes. The keys are removed. Null would be the same shape as "the
   book has no figure", and that is a different fact.
   See docs/CASH_OWNERSHIP_INVARIANTS.md. */
import { canReadDeskEarnings } from "../auth/permissions.js";

const HIDDEN = new Set([
  "earningsHome",
  "realizedPnlHome",
  "unrealizedPnlHome",
  "costOfSaleHome",
  "spreadCad",
  "costBasisHome",
  "marketValueHome",
  "marketUnitHome",
  "avgCost",
  "marketMid",
  "fromMid",
  "toMid",
]);

export function redactDeskEarnings<T>(role: string, value: T): T {
  if (canReadDeskEarnings(role)) return value;
  return strip(value, false) as T;
}

function strip(value: unknown, inActor: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => strip(item, inActor));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (HIDDEN.has(key)) continue;
      if (inActor && key === "feesHome") continue;
      out[key] = strip(child, inActor || key === "byActor");
    }
    return out;
  }
  return value;
}
