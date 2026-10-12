/* What a deal is worth, and what the desk takes on it.

   The arithmetic lives in os-src/quote-terms.js so the counter preview
   and this service are the same function. A customer rate is not rounded
   before it is multiplied. The amount the customer receives is that
   product, rounded half-up to the output currency's minor units.

   Three shapes, and the only difference between them is how many sides
   are foreign:

     customer_buy_foreign    home → foreign     the desk sells a currency
     customer_sell_foreign   foreign → home     the desk buys one
     customer_cross          foreign → foreign  it does both at once
*/
import Decimal from "decimal.js";
import { createRequire } from "node:module";

const quoteTerms = createRequire(import.meta.url)("../../../os-src/quote-terms.js").create(Decimal);

export type QuoteDirection =
  | "customer_buy_foreign"
  | "customer_sell_foreign"
  | "customer_cross";

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
  fromMid?: string;
  toMid?: string;
  /** Cross only. Falls back to `margin` where a desk prices both sides alike. */
  outMargin?: string;
  /** Defaults to CAD, so callers written for the pilot keep working. */
  homeCurrency?: string;
};

export function calculateQuoteTerms(input: QuoteTermsInput) {
  return quoteTerms.calculateQuoteTerms(input);
}

/** input × rate, half-up to the currency's minor units. The rate is not rounded first. */
export function roundOutput(amount: Decimal, rate: Decimal, currency: string): Decimal {
  return quoteTerms.roundOutput(amount, rate, currency);
}

export function minorUnits(code: string): number {
  return quoteTerms.minorUnits(code);
}
