/* Fees, earnings, and the per-teller split are the close and the
   earnings report. A teller can post a deal. These reads do not hand
   the book's take back to a role that cannot close the day and cannot
   read the earnings report. The keys are removed. Null would be the
   same shape as "the book has no figure", and that is a different fact.
   See docs/CASH_OWNERSHIP_INVARIANTS.md. */
import { canReadDeskEarnings } from "../auth/permissions.js";

const HIDDEN = new Set([
  "feesHome",
  "feeCad",
  "feeAmount",
  "earningsHome",
  "realizedPnlHome",
  "unrealizedPnlHome",
  "costOfSaleHome",
  "spreadCad",
]);

const FEE_LINE = /^Fee paid separately:/;

export function redactDeskEarnings<T>(role: string, value: T): T {
  if (canReadDeskEarnings(role)) return value;
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== "string" || !FEE_LINE.test(item))
      .map((item) => (typeof item === "string" ? item : strip(item)));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (HIDDEN.has(key)) continue;
      out[key] = strip(child);
    }
    return out;
  }
  return value;
}
