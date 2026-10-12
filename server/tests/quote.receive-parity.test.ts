/* The counter and the quote service have to hand the customer the same
   amount. These rows are the amounts, written out, so a float or a rate
   rounded before the multiply cannot sneak back in and still pass. */
import { createRequire } from "node:module";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { minorUnits as ledgerMinorUnits } from "../src/ledger/currencies.js";
import { calculateQuoteTerms } from "../src/quotes/terms.js";

const browser = createRequire(import.meta.url)("../../os-src/quote-terms.js").create(Decimal);

const rows: Array<[string, string, string, string, string, string, string]> = [
  ["customer_sell_foreign", "USD", "CAD", "3500.00", "1.36407", "0.015", "4702.63"],
  ["customer_buy_foreign", "CAD", "USD", "3500.00", "1.36407", "0.015", "2527.36"],
  ["customer_sell_foreign", "USD", "CAD", "0.01", "1.36407", "0.015", "0.01"],
  ["customer_sell_foreign", "USD", "CAD", "1.01", "1.36407", "0.015", "1.36"],
  ["customer_sell_foreign", "USD", "CAD", "9999.99", "1.36407", "0.015", "13436.08"],
  ["customer_buy_foreign", "CAD", "USD", "9999.99", "1.36407", "0.015", "7221.03"],
  ["customer_sell_foreign", "EUR", "CAD", "3500.00", "1.47102", "0.015", "5071.34"],
  ["customer_buy_foreign", "CAD", "EUR", "3500.00", "1.47102", "0.015", "2343.61"],
  ["customer_sell_foreign", "EUR", "CAD", "9.99", "1.47102", "0.02", "14.40"],
  ["customer_sell_foreign", "PHP", "CAD", "3500.00", "0.024301", "0.015", "83.78"],
  ["customer_buy_foreign", "CAD", "PHP", "3500.00", "0.024301", "0.015", "141866.59"],
  ["customer_sell_foreign", "PHP", "CAD", "9.99", "0.024301", "0.02", "0.24"],
  ["customer_sell_foreign", "INR", "CAD", "3500.00", "0.016582", "0.015", "57.17"],
  ["customer_buy_foreign", "CAD", "INR", "3500.00", "0.016582", "0.015", "207906.16"],
  ["customer_sell_foreign", "INR", "CAD", "9.99", "0.016582", "0.02", "0.16"],
  ["customer_buy_foreign", "CAD", "EUR", "9999.99", "1.471021", "0.0175", "6679.03"],
  ["customer_sell_foreign", "PHP", "CAD", "50000.01", "0.0243016", "0.01", "1202.93"],
  ["customer_sell_foreign", "USD", "CAD", "3500.00", "0.641234", "0.015", "2210.65"],
  ["customer_sell_foreign", "USD", "CAD", "3500.00", "83.456789", "0.015", "287717.28"],
  ["customer_buy_foreign", "CAD", "JPY", "1000.00", "0.00909918", "0.015", "108252.00"],
  ["customer_sell_foreign", "JPY", "CAD", "100000.00", "0.00909918", "0.015", "896.27"],
  ["customer_buy_foreign", "CAD", "JPY", "3500.00", "0.00909918", "0.02", "376957.00"],
  ["customer_sell_foreign", "JPY", "CAD", "1.00", "0.00909918", "0.015", "0.01"],
  ["customer_buy_foreign", "CAD", "USD", "250.13", "1.36407", "0.0125", "181.08"],
];

describe("receive amount parity", () => {
  it("keeps minor units with the ledger", () => {
    for (const code of ["CAD", "USD", "EUR", "PHP", "INR", "JPY", "KRW", "BHD", "KWD"]) {
      expect(browser.minorUnits(code), code).toBe(ledgerMinorUnits(code));
    }
  });

  it.each(rows)("%s %s %s %s @ %s margin %s → %s", (direction, from, to, amount, mid, margin, output) => {
    const input = {
      direction: direction as "customer_buy_foreign" | "customer_sell_foreign",
      from, to, inputAmount: amount, feeCad: "0", marketMid: mid, margin,
    };
    const server = calculateQuoteTerms(input);
    const shared = browser.calculateQuoteTerms(input);
    expect(server.outputAmount.toFixed(2)).toBe(output);
    expect(shared.outputAmount.toFixed(2)).toBe(server.outputAmount.toFixed(2));
    expect(shared.customerRate.toFixed(12)).toBe(server.customerRate.toFixed(12));
    expect(shared.spreadCad.toFixed(2)).toBe(server.spreadCad.toFixed(2));
    const board = {
      buyMargin: Number(margin),
      sellMargin: Number(margin),
      rows: { [from === "CAD" ? to : from]: { mid: Number(mid), show: true } },
    };
    const preview = browser.preview(board, { from, to, inputAmount: amount, feeCad: "0", homeCurrency: "CAD" });
    expect(preview.state).toBe("ok");
    expect(preview.outputWire).toBe(output);
    expect(preview.receivesLabel.replace(/,/g, "")).toBe(browser.formatAmount(output, to).replace(/,/g, ""));
  });

  it("does not round the mid to 4 places before the spread", () => {
    const right = calculateQuoteTerms({
      direction: "customer_sell_foreign", from: "USD", to: "CAD",
      inputAmount: "3500.00", feeCad: "0", marketMid: "1.36407", margin: "0.015",
    });
    const roundedMidFirst = new Decimal("1.3641").mul("0.985").mul("3500").toDecimalPlaces(2);
    expect(roundedMidFirst.toFixed(2)).toBe("4702.73");
    expect(right.outputAmount.toFixed(2)).toBe("4702.63");
    const roundedRateFirst = new Decimal(right.customerRate.toFixed(4)).mul("3500").toDecimalPlaces(2);
    expect(roundedRateFirst.eq(right.outputAmount)).toBe(false);
  });

  it("keeps a we-sell fee off the amount the customer receives", () => {
    const input = {
      direction: "customer_buy_foreign" as const,
      from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "1.50",
      marketMid: "1.36407", margin: "0.015",
    };
    const server = calculateQuoteTerms(input);
    const shared = browser.calculateQuoteTerms(input);
    expect(server.outputAmount.toFixed(2)).toBe("72.21");
    expect(server.fee.toFixed(2)).toBe("1.50");
    expect(shared.outputAmount.toFixed(2)).toBe("72.21");
    const preview = browser.preview(
      { buyMargin: 0.015, sellMargin: 0.015, rows: { USD: { mid: 1.36407, show: true } } },
      { from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "1.50", homeCurrency: "CAD" },
    );
    expect(preview.outputWire).toBe("72.21");
    expect(preview.feeWire).toBe("1.50");
  });

  it("rounds a half up, where banker's rounding would go to even", () => {
    const input = {
      direction: "customer_sell_foreign" as const,
      from: "USD", to: "CAD", inputAmount: "1.00", feeCad: "0",
      marketMid: "1.005", margin: "0",
    };
    const server = calculateQuoteTerms(input);
    const shared = browser.calculateQuoteTerms(input);
    const bankers = new Decimal("1.005").toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    expect(bankers.toFixed(2)).toBe("1.00");
    expect(server.outputAmount.toFixed(2)).toBe("1.01");
    expect(shared.outputAmount.toFixed(2)).toBe("1.01");
    const preview = browser.preview(
      { buyMargin: 0, sellMargin: 0, rows: { USD: { mid: 1.005, show: true } } },
      { from: "USD", to: "CAD", inputAmount: "1.00", feeCad: "0", homeCurrency: "CAD" },
    );
    expect(preview.outputWire).toBe("1.01");
    expect(preview.receivesLabel).toBe("1.01");
  });

  it("refuses a fraction of a yen and accepts a whole yen written with .00", () => {
    expect(() => calculateQuoteTerms({
      direction: "customer_sell_foreign", from: "JPY", to: "CAD",
      inputAmount: "1000.50", feeCad: "0", marketMid: "0.00909918", margin: "0.015",
    })).toThrow(/invalid money/);
    const whole = calculateQuoteTerms({
      direction: "customer_sell_foreign", from: "JPY", to: "CAD",
      inputAmount: "1000.00", feeCad: "0", marketMid: "0.00909918", margin: "0.015",
    });
    expect(whole.outputAmount.toFixed(2)).toBe("8.96");
    expect(browser.formatAmount("108252.00", "JPY")).toBe("108,252");
    expect(browser.formatAmount("4702.63", "CAD")).toBe("4,702.63");
  });
});
