/* A count is decimal text.

   0.1 + 0.2 is "0.3". 999999999.99 − 999999999.98 is "0.01".
   A binary sum of those same figures is a different string, and a
   test that only checks toFixed(2) stays green while the drawer
   is wrong. These assert the exact text.

   A mixed till prices the currencies that have a rate and leaves
   the rest out. A dong is not a dollar.
   ============================================================ */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  countProblem,
  countVariance,
  expectedAtCount,
  storedCount,
} from "../src/ledger/currencies.js";

const places = createRequire(import.meta.url)("../../os-src/currency-places.js") as {
  sumAmounts(values: string[]): string | null;
  subtractAmounts(left: string, right: string): string | null;
  roundHalfUp(amount: string, places: number): string | null;
  cadTotal(rows: { amount: string; unitsPerCad: string | null }[]): string | null;
  countProblem(raw: string, currency: string): string;
};

describe("a typed count", () => {
  const sentences: [string, string][] = [
    ["", "Enter the CAD you counted."],
    ["abc", "CAD count must be a number like 1234.50."],
    ["1,234.50", "Enter CAD without commas. Type 1234.50."],
    ["1,000,000", "Enter CAD without commas. Type 1234.50."],
    ["-5", "Enter the CAD you counted as zero or more. A minus is not a count."],
    ["1e5", "Enter CAD in digits. An exponent is not a count."],
    ["1000000001", "Enter a CAD count of 1000000000 or less."],
    ["5000.005", "CAD takes 2 decimal places. Enter a figure like 1234.50."],
    ["1000.5", "JPY has no decimals. Enter a whole number."],
    ["125.005", "Counting 125.005 KWD would drop a place. Enter 125.00 and note the rest with the owner."],
  ];

  it.each(sentences)("refuses %j", (raw, sentence) => {
    const currency = raw === "1000.5" ? "JPY" : raw === "125.005" ? "KWD" : "CAD";
    expect(countProblem(raw, currency)).toBe(sentence);
    expect(places.countProblem(raw, currency)).toBe(sentence);
  });

  it("accepts a whole yen, trailing zeros, a dinar that fits, and the cap", () => {
    for (const [raw, currency] of [
      ["189175", "JPY"],
      ["50000.00", "JPY"],
      ["125.000", "KWD"],
      ["1000000000", "CAD"],
      ["1234.50", "CAD"],
    ] as const) {
      expect(countProblem(raw, currency)).toBe("");
    }
  });
});

describe("figures the columns store", () => {
  it("sums 0.1 and 0.2 as 0.3", () => {
    expect(places.sumAmounts(["0.1", "0.2"])).toBe("0.3");
    expect(places.sumAmounts(["0.1", "0.2"])).not.toBe(String(0.1 + 0.2));
  });

  it("subtracts a cent from a figure float cannot hold", () => {
    expect(places.subtractAmounts("999999999.99", "999999999.98")).toBe("0.01");
    expect(String(Number("999999999.99") - Number("999999999.98"))).not.toBe("0.01");
  });

  it("stores a count and a variance as exact two-place text", () => {
    expect(storedCount("125.000")).toBe("125.00");
    expect(storedCount("189175")).toBe("189175.00");
    expect(countVariance("999999999.99", "999999999.98")).toBe("0.01");
    expect(String(Number("999999999.99") - Number("999999999.98"))).not.toBe("0.01");
  });

  it("rounds a yen expected amount half up, then stores two places", () => {
    expect(places.roundHalfUp("189174.85", 0)).toBe("189175");
    expect(expectedAtCount("JPY", "189174.85")).toBe("189175.00");
    expect(countVariance("189175", "189175.00")).toBe("0.00");
  });

  it("leaves a currency with no rate out of the CAD total", () => {
    const total = places.cadTotal([
      { amount: "1000", unitsPerCad: "1" },
      { amount: "730", unitsPerCad: "0.73" },
      { amount: "5000000", unitsPerCad: null },
    ]);
    expect(total).toBe("2000");
    expect(total).not.toBe("5002000");
  });
});
