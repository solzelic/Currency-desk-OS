/* ============================================================
   Storefront hold pricing — Decimal, once.

   The SMS quote path and the public rate board must price off the
   same published board with the same arithmetic. IEEE `*` `/` on
   those figures is forbidden: a customer-facing hold is persisted
   and shown at the counter.

   This is NOT the desk quote door (`quotes/terms.ts`). The storefront
   sells foreign over mid (`mid * (1 + sellMargin)`) and buys under
   mid (`mid * (1 - buyMargin)`); crosses settle through CAD. Do not
   "align" this with `customer_buy_foreign` — that would change every
   held SMS rate.
   ============================================================ */
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type StorefrontBoardRow = {
  mid: Decimal.Value;
  spread?: Decimal.Value;
};

export type StorefrontBoard = {
  buyMargin: Decimal.Value;
  sellMargin: Decimal.Value;
  rows: Record<string, StorefrontBoardRow | undefined>;
};

const HOME = "CAD";

function dec(value: Decimal.Value, what: string): Decimal {
  const out = new Decimal(value);
  if (!out.isFinite()) throw new Error(`invalid ${what}`);
  return out;
}

function marginOf(row: StorefrontBoardRow | undefined, boardMargin: Decimal.Value): Decimal {
  const raw = row?.spread ?? boardMargin;
  const out = dec(raw, "margin");
  if (out.lt(0) || out.gte(1)) throw new Error("invalid board terms");
  return out;
}

function midOf(row: StorefrontBoardRow): Decimal {
  const out = dec(row.mid, "mid");
  if (out.lte(0)) throw new Error("invalid mid");
  return out;
}

/** CAD per 1 unit — we buy foreign under mid. */
export function storefrontBuyRate(row: StorefrontBoardRow, boardBuyMargin: Decimal.Value): Decimal {
  return midOf(row).mul(new Decimal(1).sub(marginOf(row, boardBuyMargin)));
}

/** CAD per 1 unit — we sell foreign over mid. */
export function storefrontSellRate(row: StorefrontBoardRow, boardSellMargin: Decimal.Value): Decimal {
  return midOf(row).mul(new Decimal(1).add(marginOf(row, boardSellMargin)));
}

/** Window-display buy/sell, 6 decimal places — same as the previous toFixed(6). */
export function storefrontDisplayPair(
  row: StorefrontBoardRow,
  buyMargin: Decimal.Value,
  sellMargin: Decimal.Value,
): { buy: number; sell: number } {
  return {
    buy: Number(storefrontBuyRate(row, buyMargin).toDecimalPlaces(6).toFixed(6)),
    sell: Number(storefrontSellRate(row, sellMargin).toDecimalPlaces(6).toFixed(6)),
  };
}

export type StorefrontHold = {
  haveAmount: Decimal;
  receiveAmount: Decimal;
  quotedRate: Decimal;
};

export function priceStorefrontHold(input: {
  from: string;
  to: string;
  amount: Decimal.Value;
  board: StorefrontBoard;
}): StorefrontHold {
  const haveAmount = dec(input.amount, "amount").toDecimalPlaces(2);
  if (haveAmount.lte(0)) throw new Error("invalid amount");

  const fromRow = input.board.rows[input.from];
  const toRow = input.board.rows[input.to];
  if (input.from !== HOME && !fromRow) throw new Error("unknown currency");
  if (input.to !== HOME && !toRow) throw new Error("unknown currency");

  const cad =
    input.from === HOME
      ? haveAmount
      : haveAmount.mul(storefrontBuyRate(fromRow!, input.board.buyMargin));
  const receive =
    input.to === HOME
      ? cad
      : cad.div(storefrontSellRate(toRow!, input.board.sellMargin));

  const receiveAmount = receive.toDecimalPlaces(2);
  /* Rate is reconstructed from the money the customer was shown, so a
     teller can reproduce the hold from the stored amounts alone. */
  const quotedRate = receiveAmount.div(haveAmount);
  return { haveAmount, receiveAmount, quotedRate };
}

export function moneyFixed(value: Decimal): string {
  return value.toDecimalPlaces(2).toFixed(2);
}

export function rateFixed(value: Decimal): string {
  return value.toDecimalPlaces(12).toFixed(12);
}

export function jsonMoney(value: Decimal.Value): number {
  return Number(new Decimal(value).toDecimalPlaces(2).toFixed(2));
}

export function jsonRate(value: Decimal.Value): number {
  return Number(new Decimal(value).toDecimalPlaces(12).toFixed(12));
}

export function jsonMargin(value: Decimal.Value): number {
  return Number(new Decimal(value).toDecimalPlaces(12).toFixed(12));
}
