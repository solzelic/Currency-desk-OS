import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { effectiveRate, effectiveRateText, MIN_RATE_PLACES, MAX_RATE_PLACES, RATE_NOTE } = require(
  join(root, "os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string, payout: string, places: number | null) => { text: string; rounded: boolean };
  effectiveRateText: (amount: string, payout: string, places: number | null) => string;
  MIN_RATE_PLACES: number;
  MAX_RATE_PLACES: number;
  RATE_NOTE: string;
};

function placesOf(text: string): number {
  const frac = text.split(".")[1] || "";
  return frac.length;
}

describe("effective rate", () => {
  it("names the bounds and the note", () => {
    expect(MIN_RATE_PLACES).toBe(4);
    expect(MAX_RATE_PLACES).toBe(6);
    expect(RATE_NOTE).toBe("Rate rounded. The amounts are exact.");
  });

  it("pads an exact deal to four places and shows no note", () => {
    const rate = effectiveRate("100.00", "10825.00", 0);
    expect(rate).toEqual({ text: "108.2500", rounded: false });
    expect(placesOf(rate.text)).toBeGreaterThanOrEqual(4);
    expect(placesOf(rate.text)).toBeLessThanOrEqual(6);
    expect(rate.text).not.toBe("108.25");
    expect(rate.text).not.toBe("108.2515");
  });

  it("keeps five places when five multiply out exactly", () => {
    const rate = effectiveRate("3000.00", "2166.75", 2);
    expect(rate).toEqual({ text: "0.72225", rounded: false });
    expect(placesOf(rate.text)).toBe(5);
  });

  it("keeps six places when only six multiply out exactly", () => {
    const rate = effectiveRate("1000000", "722103", 0);
    expect(rate).toEqual({ text: "0.722103", rounded: false });
    expect(placesOf(rate.text)).toBe(6);
  });

  it("shows four places and the note when six cannot hit the payout", () => {
    const rate = effectiveRate("3000.00", "2166.31", 2);
    expect(rate).toEqual({ text: "0.7221", rounded: true });
    expect(placesOf(rate.text)).toBe(4);
    expect(RATE_NOTE).toBe("Rate rounded. The amounts are exact.");
  });

  it("returns no figure before the scale is known", () => {
    expect(effectiveRate("100.00", "10825", null)).toEqual({ text: "", rounded: false });
    expect(effectiveRateText("100.00", "10825", null)).toBe("");
  });
});
