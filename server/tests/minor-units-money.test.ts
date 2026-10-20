/* Yen and won are paid in whole units. These fail while quote terms
   still round every payout to two decimal places. */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { parseMoney, roundTo } from "../src/ledger/currencies.js";
import { LedgerError } from "../src/ledger/service.js";
import { calculateQuoteTerms } from "../src/quotes/terms.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const halfUp = (amount: Decimal.Value, places: number) =>
  new Decimal(amount).toDecimalPlaces(places, Decimal.ROUND_HALF_UP);

const buy = (to: string, mid: string, margin = "0.03") =>
  calculateQuoteTerms({
    direction: "customer_buy_foreign",
    from: "CAD",
    to,
    inputAmount: "100.00",
    feeCad: "0.00",
    marketMid: mid,
    margin,
  });

describe("minor units on a quote", () => {
  it("pays whole yen for 100 CAD, and the home legs add up", () => {
    const q = buy("JPY", "0.009276");
    const raw = new Decimal(100).mul(new Decimal(1).div("0.009276").mul("0.97"));
    expect(q.outputAmount.eq(halfUp(raw, 0))).toBe(true);
    expect(raw.toDecimalPlaces(2).eq(q.outputAmount)).toBe(false);
    expect(q.inputCad.sub(q.outputCad).eq(q.spreadCad)).toBe(true);
    expect(q.spreadCad.gte(0)).toBe(true);
  });

  it("pays whole won the same way", () => {
    const q = buy("KRW", "0.00098");
    const raw = new Decimal(100).mul(new Decimal(1).div("0.00098").mul("0.97"));
    expect(q.outputAmount.eq(halfUp(raw, 0))).toBe(true);
    expect(q.inputCad.sub(q.outputCad).eq(q.spreadCad)).toBe(true);
  });

  it("rounds a half unit up, including 1000.5 yen", () => {
    expect(roundTo(new Decimal("1000.5"), "JPY").toString()).toBe("1001");
    expect(roundTo(new Decimal("1000.5"), "KRW").toString()).toBe("1001");
    expect(roundTo(new Decimal("-1.5"), "JPY").toString()).toBe("-2");
    /* 100 * (1/mid) * 0.97 is 1000.5. Two-place rounding leaves 1000.50. */
    const mid = "0.09695152423788105947";
    const raw = new Decimal(100).mul(new Decimal(1).div(mid).mul("0.97"));
    const q = buy("JPY", mid, "0.03");
    expect(q.outputAmount.eq(halfUp(raw, 0))).toBe(true);
    expect(q.outputAmount.toString()).toBe("1001");
    expect(q.inputCad.sub(q.outputCad).eq(q.spreadCad)).toBe(true);
  });

  it("keeps three places for a dinar", () => {
    expect(roundTo(new Decimal("1.2345"), "KWD").toString()).toBe("1.235");
    expect(roundTo(new Decimal("1.2345"), "BHD").toString()).toBe("1.235");
    const q = buy("KWD", "4.2");
    const raw = new Decimal(100).mul(new Decimal(1).div("4.2").mul("0.97"));
    expect(q.outputAmount.eq(halfUp(raw, 3))).toBe(true);
    expect(q.outputAmount.toFixed(3)).toBe("23.095");
    expect(halfUp(raw, 2).toFixed(2)).toBe("23.10");
  });

  it("matches Decimal half-up across the scales", () => {
    const scales: [string, number][] = [
      ["JPY", 0], ["KRW", 0], ["USD", 2], ["KWD", 3], ["BHD", 3],
    ];
    for (const [code, places] of scales) {
      for (let i = 0; i < 40; i++) {
        const raw = new Decimal(i).div(7).minus("3.5");
        expect(roundTo(raw, code).eq(halfUp(raw, places))).toBe(true);
      }
    }
    for (let i = 1; i <= 25; i++) {
      const mid = new Decimal(i).div(1000).add("0.001");
      const q = buy("JPY", mid.toFixed(8), "0.05");
      const raw = new Decimal(100).mul(new Decimal(1).div(mid).mul("0.95"));
      expect(q.outputAmount.eq(halfUp(raw, 0))).toBe(true);
      expect(q.inputCad.sub(q.outputCad).eq(q.spreadCad)).toBe(true);
    }
  });

  it("refuses an amount with more decimals than the currency has", () => {
    expect(() => parseMoney("10000.55", "JPY", "Amount")).toThrow(LedgerError);
    expect(() => parseMoney("10000.55", "JPY", "Amount")).toThrow(/no minor unit/);
    expect(() => parseMoney("10000.55", "KRW", "Amount")).toThrow(/no minor unit/);
    expect(() => parseMoney("1.234", "USD", "Amount")).toThrow(/2 decimal places/);
    expect(parseMoney("10781.00", "JPY", "Payout").toString()).toBe("10781");
    expect(parseMoney("1.230", "USD", "Amount").toString()).toBe("1.23");
  });
});
