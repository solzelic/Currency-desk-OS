import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { effectiveRate, MIN_RATE_PLACES, MAX_RATE_PLACES, RATE_NOTE } = require(
  join(root, "os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string, payout: string, places: number | null) => { text: string; rounded: boolean };
  MIN_RATE_PLACES: number;
  MAX_RATE_PLACES: number;
  RATE_NOTE: string;
};

/* The desk amount line. maximumFractionDigits 2, with no minimum,
   so 1234.5 stays one decimal. */
const num = (n: number) =>
  new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(Number(n) || 0);

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
  });

  it("keeps 1,234.5 INR at one decimal and does not round 0.0118 to 0.01", () => {
    const base = readFileSync(join(root, "os-src/cdos-base.jsx"), "utf8");
    expect(base).toContain(
      "const num = (n) => new Intl.NumberFormat('en-CA', { maximumFractionDigits: 2 }).format(Number(n) || 0);",
    );
    const modal = readFileSync(join(root, "os-src/cdos-txmodal.jsx"), "utf8");
    expect(modal).toContain("num(out.amt)");
    expect(modal).not.toContain("unitText");
    expect(`${num(1234.5)} INR`).toBe("1,234.5 INR");
    /* 100 INR pays 1.18 USD. The ratio is 0.0118. Two-place rounding
       of that ratio is 0.01. The line beside the payout is four places. */
    expect(num(0.0118)).toBe("0.01");
    const exact = effectiveRate("100.00", "1.18", 2);
    expect(exact).toEqual({ text: "0.0118", rounded: false });
    expect(`1 INR = ${exact.text} USD`).toBe("1 INR = 0.0118 USD");
    expect(exact.text).not.toBe("0.01");
    /* 1,234.5 INR times 0.0118 is 14.5671, paid as 14.57. Six places
       still miss, so the note is on and the rate stays 0.0118. */
    const rounded = effectiveRate("1234.5", "14.57", 2);
    expect(rounded).toEqual({ text: "0.0118", rounded: true });
    expect(`1 INR = ${rounded.text} USD`).toBe("1 INR = 0.0118 USD");
    expect(RATE_NOTE).toBe("Rate rounded. The amounts are exact.");
  });
});
