/* Storefront SMS holds must price with Decimal, not IEEE float.
   The formula itself is unchanged (buy under mid, sell over mid,
   crosses via CAD); only the arithmetic discipline is pinned. */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  priceStorefrontHold,
  storefrontDisplayPair,
  storefrontSellRate,
} from "../src/sites/storefront-hold.js";

describe("storefront hold pricing", () => {
  it("uses Decimal on a mid/margin pair that IEEE float gets wrong", () => {
    /* 1.1 * 1.1 is the textbook residue: 1.2100000000000002 */
    expect(1.1 * (1 + 0.1)).not.toBe(1.21);
    expect(new Decimal("1.1").mul(new Decimal("1.1")).toString()).toBe("1.21");

    const priced = priceStorefrontHold({
      from: "CAD",
      to: "USD",
      amount: "10.00",
      board: {
        buyMargin: "0",
        sellMargin: "0.1",
        rows: { USD: { mid: "1.1" } },
      },
    });

    const expected = new Decimal("10").div("1.21").toDecimalPlaces(2);
    expect(priced.receiveAmount.toFixed(2)).toBe(expected.toFixed(2));
    expect(priced.quotedRate.mul(priced.haveAmount).toDecimalPlaces(2).eq(priced.receiveAmount)).toBe(true);
    /* Float would have divided by 1.2100000000000002, not 1.21. */
    expect(storefrontSellRate({ mid: "1.1" }, "0.1").eq("1.21")).toBe(true);
  });

  it("prices a CAD→foreign hold at mid*(1+sellMargin), 2dp money", () => {
    const priced = priceStorefrontHold({
      from: "CAD",
      to: "USD",
      amount: "1000",
      board: {
        buyMargin: "0.02",
        sellMargin: "0.03",
        rows: { USD: { mid: "2" } },
      },
    });
    /* 1000 / (2 * 1.03) = 485.4368… → 485.44 */
    expect(priced.haveAmount.toFixed(2)).toBe("1000.00");
    expect(priced.receiveAmount.toFixed(2)).toBe("485.44");
    expect(priced.quotedRate.toDecimalPlaces(12).toFixed(12)).toBe(
      new Decimal("485.44").div("1000").toDecimalPlaces(12).toFixed(12),
    );
  });

  it("prices a foreign→CAD hold at mid*(1-buyMargin)", () => {
    const priced = priceStorefrontHold({
      from: "USD",
      to: "CAD",
      amount: "500",
      board: {
        buyMargin: "0.02",
        sellMargin: "0.03",
        rows: { USD: { mid: "2" } },
      },
    });
    /* 500 * (2 * 0.98) = 980.00 */
    expect(priced.receiveAmount.toFixed(2)).toBe("980.00");
  });

  it("settles a cross through CAD, same as the public quote path", () => {
    const priced = priceStorefrontHold({
      from: "USD",
      to: "EUR",
      amount: "100",
      board: {
        buyMargin: "0.02",
        sellMargin: "0.03",
        rows: { USD: { mid: "2" }, EUR: { mid: "1.5" } },
      },
    });
    /* cad = 100 * 2 * 0.98 = 196; receive = 196 / (1.5 * 1.03) = 126.8608… → 126.86 */
    expect(priced.receiveAmount.toFixed(2)).toBe("126.86");
  });

  it("lets a per-currency spread override the board margin on both sides", () => {
    const pair = storefrontDisplayPair({ mid: "2", spread: "0.10" }, "0.02", "0.02");
    expect(pair).toEqual({ buy: 1.8, sell: 2.2 });
  });
});
