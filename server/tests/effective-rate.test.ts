/* The rate on the sheet, the summary, and the receipt has to multiply
   back to the payout. A 12-place stored rate, and a published rate
   rounded on its own, both fail that check. Six places is the cap.
   Past that, the rate is rounded to four and marked, and the payout
   stays the payout. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { effectiveRate, effectiveRateText, rateMultiplies, EXACT_RATE_PLACES, ROUNDED_RATE_PLACES } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string | number, payout: string | number, places: number) => { text: string; rounded: boolean };
  effectiveRateText: (amount: string | number, payout: string | number, places: number) => string;
  rateMultiplies: (rate: string, amount: string | number, payout: string | number, places: number) => boolean;
  EXACT_RATE_PLACES: number;
  ROUNDED_RATE_PLACES: number;
};

describe("effective rate on the sheet and the receipt", () => {
  it("keeps the two caps in one place", () => {
    expect(EXACT_RATE_PLACES).toBe(6);
    expect(ROUNDED_RATE_PLACES).toBe(4);
  });

  it("100 CAD to 10,825 JPY displays 108.25, which multiplies back", () => {
    const rate = effectiveRate("100.00", "10825.00", 0);
    expect(rate).toEqual({ text: "108.25", rounded: false });
    expect(effectiveRateText("100.00", "10825.00", 0)).toBe("108.25");
    expect(rateMultiplies(rate.text, "100.00", "10825.00", 0)).toBe(true);
    expect((rate.text.split(".")[1] || "").length).toBeLessThanOrEqual(EXACT_RATE_PLACES);
  });

  it("goes red for the three figures this deal was showing", () => {
    expect(rateMultiplies("108.2661", "100.00", "10825.00", 0)).toBe(false);
    expect(rateMultiplies("108.27", "100.00", "10825.00", 0)).toBe(false);
    expect(rateMultiplies("108.251512773679", "100.00", "10825.00", 0)).toBe(false);
  });

  it("uses four places when fewer places miss the payout", () => {
    const rate = effectiveRate("10000", "1082515", 0);
    expect(rate).toEqual({ text: "108.2515", rounded: false });
    expect(rateMultiplies(rate.text, "10000", "1082515", 0)).toBe(true);
    expect(rateMultiplies("108.25", "10000", "1082515", 0)).toBe(false);
  });

  it("does not guess a scale before the places are known", () => {
    expect(effectiveRate("100.00", "10825.00", null as unknown as number)).toEqual({ text: "", rounded: false });
    expect(rateMultiplies("108.25", "100.00", "10825.00", null as unknown as number)).toBe(false);
  });

  it("uses more than four places when four would miss the cents", () => {
    const rate = effectiveRate("3000.00", "2166.31", 2);
    expect(rate.rounded).toBe(false);
    expect(rate.text).not.toBe("");
    expect((rate.text.split(".")[1] || "").length).toBeGreaterThan(4);
    expect((rate.text.split(".")[1] || "").length).toBeLessThanOrEqual(EXACT_RATE_PLACES);
    expect(rateMultiplies(rate.text, "3000.00", "2166.31", 2)).toBe(true);
    expect(rateMultiplies("0.7221", "3000.00", "2166.31", 2)).toBe(false);
  });

  it("rounds to four and says so when six places still miss the cents", () => {
    const rate = effectiveRate("30000.00", "21663.10", 2);
    expect(rate.rounded).toBe(true);
    expect(rate.text).toBe("0.7221");
    expect((rate.text.split(".")[1] || "").length).toBe(ROUNDED_RATE_PLACES);
    expect(rateMultiplies(rate.text, "30000.00", "21663.10", 2)).toBe(false);
    expect(rateMultiplies("0.722103", "30000.00", "21663.10", 2)).toBe(false);
  });

  it("pays whole won the same way", () => {
    const rate = effectiveRate("100.00", "98980", 0);
    expect(rate).toEqual({ text: "989.8", rounded: false });
    expect(rateMultiplies(rate.text, 100, 98980, 0)).toBe(true);
  });
});
