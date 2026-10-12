/* Shop earnings, P&L, cost of sale, the booked spread, unrealized
   P&L, and the per-teller money split. A teller can post a deal.
   These reads do not hand the book's take back to a role that cannot
   close the day and cannot read the earnings report.

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
