/* The rate next to a payout is the rate that payout came from, rounded
   half up to four places. It is not the board rate, and it does not
   have to multiply back to the cent. The payout stays the payout. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { effectiveRate, effectiveRateText, DISPLAY_RATE_PLACES, RECEIPT_RATE_NOTE } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../../os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string | number, payout: string | number, places: number) => { text: string };
  effectiveRateText: (amount: string | number, payout: string | number, places: number) => string;
  DISPLAY_RATE_PLACES: number;
  RECEIPT_RATE_NOTE: string;
};

function placesOf(text: string): number {
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

describe("effective rate on the sheet and the receipt", () => {
  it("rounds the payout's own rate to four places", () => {
    expect(DISPLAY_RATE_PLACES).toBe(4);
    expect(RECEIPT_RATE_NOTE).toBe("Rate rounded to 4 places. The amounts above are exact.");
  });

  it("100 CAD to 10,825 JPY displays 108.2500, not the board rate", () => {
    const rate = effectiveRate("100.00", "10825.00", 0);
    expect(rate).toEqual({ text: "108.2500" });
    expect(effectiveRateText("100.00", "10825.00", 0)).toBe("108.2500");
    expect(rate.text).not.toBe("108.2515");
    expect(placesOf(rate.text)).toBe(4);
  });

  it("3000.00 CAD to 2166.31 USD displays 0.7221", () => {
    const rate = effectiveRate("3000.00", "2166.31", 2);
    expect(rate.text).toBe("0.7221");
    expect(placesOf(rate.text)).toBe(4);
    /* 0.7221 times 3000.00 is 2166.30. The payout on the deal stays 2166.31. */
    expect(rate.text).not.toBe("0.722103");
  });

  it("does not keep a fifth decimal when the rate sits on a half", () => {
    expect(effectiveRateText("3000.00", "2166.75", 2)).toBe("0.7223");
    expect(placesOf(effectiveRateText("3000.00", "2166.75", 2))).toBe(4);
  });

  it("does not guess a scale before the places are known", () => {
    expect(effectiveRate("100.00", "10825.00", null as unknown as number)).toEqual({ text: "" });
    expect(effectiveRateText("3000.00", "2166.31", null as unknown as number)).toBe("");
  });

  it("pays whole won the same way", () => {
    expect(effectiveRate("100.00", "98980", 0)).toEqual({ text: "989.8000" });
  });
});
