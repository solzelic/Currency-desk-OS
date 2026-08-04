/* ============================================================
   What a deal is worth, and what the desk takes on it.

   Three shapes, and the only difference between them is how many sides are
   foreign:

     customer_buy_foreign    home → foreign     the desk sells a currency
     customer_sell_foreign   foreign → home     the desk buys one
     customer_cross          foreign → foreign  it does both at once

   Every rate on the board is HOME CURRENCY PER ONE UNIT of a currency — a
   "mid". A cross therefore needs two of them, and is settled through the
   home currency even though none changes hands: that notional home value is
   what the books are kept in and what the margin is measured against.

   Margin always moves the price against the customer, never for them. On a
   cross it applies twice, because the desk is buying one currency and
   selling another in the same movement — precisely what it would earn if
   the customer did this as two deals through the home currency.

   Note "home", not CAD. This used to hardcode Canada; the jurisdiction pack
   on the legal entity now says what a desk's home currency is, and this
   takes it as an argument.

   Previously three dense one-line functions. It is the arithmetic that
   decides what a person is handed at a counter, so it is written to be read.
   ============================================================ */
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type QuoteDirection =
  | "customer_buy_foreign"
  | "customer_sell_foreign"
  | "customer_cross";

const money = (value: string, min: Decimal.Value) => {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new Error("invalid money");
  const out = new Decimal(value);
  if (out.lt(min) || out.gt("1000000000")) throw new Error("out of range");
  return out.toDecimalPlaces(2);
};

const rateOf = (value: Decimal.Value | undefined, what: string) => {
  const out = new Decimal(value ?? NaN);
  if (!out.isFinite() || out.lte(0)) throw new Error(`invalid ${what}`);
  return out;
};

const marginOf = (value: Decimal.Value) => {
  const out = new Decimal(value);
  if (!out.isFinite() || out.lt(0) || out.gte(1))
    throw new Error("invalid board terms");
  return out;
};

export type QuoteTermsInput = {
  direction: QuoteDirection;
  from: string;
  to: string;
  inputAmount: string;
  /** Charged separately, in the desk's home currency. */
  feeCad: string;
  /** Home per one unit of the foreign side. Unused by a cross. */
  marketMid: string;
  margin: string;
  /* A cross needs the home value of BOTH sides. `marketMid` cannot describe
     two foreign currencies, and quietly reusing it would price the deal at
     one-for-one, so a cross must supply these. */
  fromMid?: string;
  toMid?: string;
  /** Cross only. Falls back to `margin` where a desk prices both sides alike. */
  outMargin?: string;
  /** Defaults to CAD, so callers written for the pilot keep working. */
  homeCurrency?: string;
};

export function calculateQuoteTerms(input: QuoteTermsInput) {
  const home = (input.homeCurrency ?? "CAD").toUpperCase();
  const amount = money(input.inputAmount, "0.01");
  const fee = money(input.feeCad, "0");
  const margin = marginOf(input.margin);

  const fromIsHome = input.from === home;
  const toIsHome = input.to === home;
  if (input.from === input.to) throw new Error("direction and currencies disagree");

  /* The direction the caller states and the currencies they gave are two
     descriptions of the same deal. A disagreement means somebody built the
     wrong request, and there is no safe way to pick which half was right. */
  const shape =
    fromIsHome && !toIsHome
      ? "customer_buy_foreign"
      : toIsHome && !fromIsHome
        ? "customer_sell_foreign"
        : "customer_cross";
  if (shape !== input.direction) throw new Error("direction and currencies disagree");

  if (shape === "customer_cross") {
    const fromMid = rateOf(input.fromMid, "board terms");
    const toMid = rateOf(input.toMid, "board terms");
    const outMargin = marginOf(input.outMargin ?? input.margin);

    /* Valued on the side that actually arrived: the customer's currency is
       what the desk received, so that is what the deal is worth to it, and
       pricing off the incoming side leaves the margin as the only thing
       moving the customer's number. */
    const inputHome = amount.mul(fromMid).toDecimalPlaces(2);
    const kept = new Decimal(1).sub(margin).mul(new Decimal(1).sub(outMargin));
    const customerRate = fromMid.div(toMid).mul(kept);
    const outputAmount = amount.mul(customerRate).toDecimalPlaces(2);
    const outputHome = outputAmount.mul(toMid).toDecimalPlaces(2);
    const spreadCad = inputHome.sub(outputHome).toDecimalPlaces(2);
    if (spreadCad.lt(0)) throw new Error("negative spread");

    return {
      input: amount,
      fee,
      /* A cross has no single mid. This is the one it is VALUED at — the
         incoming side's — and both are returned so a quote can freeze each:
         a cross re-priced later from one number is a cross priced wrongly. */
      mid: fromMid,
      fromMid,
      toMid,
      customerRate,
      outputAmount,
      inputCad: inputHome,
      outputCad: outputHome,
      spreadCad,
      buyOrSellSide: "we_cross" as const,
    };
  }

  const mid = rateOf(input.marketMid, "board terms");
  /* Buying foreign, the customer hands over home currency and receives
     units, so their rate is units-per-home. Selling, they hand over units
     and receive home currency, so it is home-per-unit. Margin shrinks
     whichever of those the customer is receiving. */
  const customerRate =
    shape === "customer_buy_foreign"
      ? new Decimal(1).div(mid).mul(new Decimal(1).sub(margin))
      : mid.mul(new Decimal(1).sub(margin));
  const outputAmount = amount.mul(customerRate).toDecimalPlaces(2);
  const inputCad = fromIsHome ? amount : amount.mul(mid).toDecimalPlaces(2);
  const outputCad = toIsHome ? outputAmount : outputAmount.mul(mid).toDecimalPlaces(2);
  const spreadCad = inputCad.sub(outputCad).toDecimalPlaces(2);
  if (spreadCad.lt(0)) throw new Error("negative spread");

  return {
    input: amount,
    fee,
    mid,
    fromMid: fromIsHome ? new Decimal(1) : mid,
    toMid: toIsHome ? new Decimal(1) : mid,
    customerRate,
    outputAmount,
    inputCad,
    outputCad,
    spreadCad,
    buyOrSellSide:
      shape === "customer_buy_foreign" ? ("we_sell" as const) : ("we_buy" as const),
  };
}
