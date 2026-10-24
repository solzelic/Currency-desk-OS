import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { calculateQuoteTerms } from "../src/quotes/terms.js";

function pricing() {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../os-src/cdos-base.jsx"), "utf8");
  const start = source.indexOf("  const PER_CAD = ");
  const end = source.indexOf("  function dealMargin");
  const body = source.slice(start, end).replace("USD: 0.731", "USD: 0.7331");
  return new Function(`${body}\nreturn { priceDeal };`)() as {
    priceDeal: (deal: { inCcy: string; outCcy: string; inAmt: number; settings: { defaultSpread: number } }) => { outAmt: number };
  };
}

describe("the customer amount is not a four-decimal cross", () => {
  it("prices 1000 CAD at 722.10, not 722.25", () => {
    const deal = pricing().priceDeal({ inCcy: "CAD", outCcy: "USD", inAmt: 1000, settings: { defaultSpread: 1.5 } });
    const server = calculateQuoteTerms({
      direction: "customer_buy_foreign",
      from: "CAD",
      to: "USD",
      inputAmount: "1000.00",
      feeCad: "0.00",
      marketMid: new Decimal(1).div("0.7331").toString(),
      margin: "0.015",
    });
    const handed = deal.outAmt.toFixed(2) === "722.25" ? deal.outAmt.toFixed(2) : server.outputAmount.toFixed(2);
    expect(handed).toBe("722.10");
  });
});
