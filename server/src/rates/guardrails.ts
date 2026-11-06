/* Rates v2.5 guardrails, checked by the server when a deal posts.

   The shop sets them on the Guardrails tab, in the desk document
   (tenant_state, key cdos_settings): a floor (marginFloorPct), a floor per
   currency (marginFloorByCcy, the owner's), and what happens below it
   (marginEnforce: "block", the default, or "warn"). The new-deal screen
   meters every deal against them (os-src/cdos-txmodal.jsx); until now
   nothing stopped a deal posted straight to the API. quotes/service.ts
   applies this rule at post.

   floorFor is the browser's rule (os-src/rates-board.js), ported; the
   test file runs both on the same cases. The margin is Decimal, never
   floating point (engineering standard §3): in floats a deal exactly at
   its floor can read as just under it. */
import Decimal from "decimal.js";

export type Enforce = "block" | "warn";

/* The desk document saves cdos_settings as the browser's JSON text, or as
   an object. Anything else is no settings. */
export function readDeskSettings(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* The floor a currency is held to: its own when the owner set one, else
   the shop's, else 0.5%. Blank, not a number, or negative is not a floor. */
export function floorFor(settings: unknown, code: string): number {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const byCcy = s.marginFloorByCcy && typeof s.marginFloorByCcy === "object" ? (s.marginFloorByCcy as Record<string, unknown>) : null;
  const own = byCcy ? pct(byCcy[code]) : null;
  if (own !== null) return own;
  const shop = pct(s.marginFloorPct);
  return shop !== null ? shop : 0.5;
}

/* Below the floor a deal is blocked unless the shop chose to warn only. */
export function enforceOf(settings: Record<string, unknown>): Enforce {
  return settings.marginEnforce === "warn" ? "warn" : "block";
}

/* A deal's margin as the new-deal screen meters it: what the desk keeps
   (the booked spread plus the fee) over the deal's size in the home
   currency, in percent. A cross deal is sized at the market mid of what
   the customer pays. Null when there is nothing to measure. The amounts
   are the quote's stored decimal strings. */
export function dealMarginPct(deal: {
  home: string; from: string; to: string;
  inputAmount: Decimal.Value; outputAmount: Decimal.Value; marketMid: Decimal.Value;
  spread: Decimal.Value; fee: Decimal.Value;
}): Decimal | null {
  let basis: Decimal, kept: Decimal;
  try {
    basis = deal.from === deal.home ? new Decimal(deal.inputAmount)
      : deal.to === deal.home ? new Decimal(deal.outputAmount)
        : new Decimal(deal.inputAmount).mul(deal.marketMid);
    kept = new Decimal(deal.spread).add(deal.fee);
  } catch {
    /* Not a number: there is no margin to measure, so the floor is not
       checked. The ledger still checks the amounts themselves when the
       deal posts. */
    return null;
  }
  if (!basis.isFinite() || basis.lte(0) || !kept.isFinite()) return null;
  return kept.div(basis).mul(100);
}
