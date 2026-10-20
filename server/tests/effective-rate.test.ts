import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { effectiveRate, boardRateText, MIN_RATE_PLACES, MAX_RATE_PLACES, RATE_NOTE } = require(
  join(root, "os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string, payout: string, places: number | null) => { text: string; rounded: boolean };
  boardRateText: (rate: number) => string;
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

  it("keeps four significant digits on a small rate", () => {
    /* 1,000,000 KRW pays 725.40. Four places is 0.0007. */
    const krw = effectiveRate("1000000.00", "725.40", 2);
    expect(krw).toEqual({ text: "0.0007254", rounded: false });
    expect(krw.text).not.toBe("0.0007");
    /* 1,000,000 pays 98.50. Four places half-up is 0.0001. */
    const idr = effectiveRate("1000000.00", "98.50", 2);
    expect(idr).toEqual({ text: "0.0000985", rounded: false });
    expect(idr.text).not.toBe("0.0001");
  });

  it("keeps 0.00098 on the board rate instead of 0.0010", () => {
    expect(boardRateText(0.00098)).toBe("0.00098");
    expect(boardRateText(0.00098)).not.toBe("0.0010");
    expect(boardRateText(0.72225)).toBe("0.72225");
  });

  it("rounds half up, and does not truncate", () => {
    /* 2,166.46 / 3,000 is 0.7221533. Half up at four places is 0.7222.
       Cutting the remainder off would leave 0.7221. */
    const rate = effectiveRate("3000.00", "2166.46", 2);
    expect(rate).toEqual({ text: "0.7222", rounded: true });
    expect(rate.text).not.toBe("0.7221");
  });
});

function fnBody(source: string, name: string): string {
  const at = source.indexOf("function " + name);
  if (at < 0) throw new Error("missing " + name);
  const paren = source.indexOf("(", at);
  let depth = 0;
  let i = paren;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const open = source.indexOf("{", i);
  depth = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === "{") depth += 1;
    else if (source[j] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, j + 1);
    }
  }
  throw new Error("unclosed " + name);
}

describe("rate on the receipt, the deal, and the sheet", () => {
  const modal = readFileSync(join(root, "os-src/cdos-txmodal.jsx"), "utf8");
  const ledger = readFileSync(join(root, "os-src/cdos-ledger.jsx"), "utf8");
  const modules = readFileSync(join(root, "os-src/cdos-modules.jsx"), "utf8");
  const receipt = fnBody(modules, "ReceiptModal");
  const shown = fnBody(ledger, "shownDealRate");
  const note = fnBody(ledger, "RateNote");
  const present = fnBody(modal, "PresentQuote");

  it("prints the effective rate on the receipt, with the note when rounded", () => {
    expect(receipt).toContain("effectiveRate(row.inAmt, row.outAmt");
    expect(receipt).toContain("' = ' + priced.text + ' '");
    expect(receipt).toContain("priced.rounded");
    expect(receipt).toContain("cd-rate-note");
    expect(receipt).toContain("RATE_NOTE");
    expect(receipt).not.toMatch(/k="Rate" v=\{row\.rate\}/);
    expect(receipt).not.toContain("row.rate +");
  });

  it("prints the effective rate on the deal detail, not the stored rate", () => {
    expect(shown).toContain("dealRate(row)");
    expect(shown).toContain("return `1 ${row.inCcy} = ${rate.text} ${row.outCcy}`");
    expect(note).toContain("rate.rounded");
    expect(note).toContain("RATE_NOTE");
    expect(ledger).toContain('DRow k="Rate" v={shownDealRate(row)}');
  });

  it("keeps the note under the rate on the desk sheet", () => {
    const pay = modal.indexOf(">Customer pays in<");
    const receive = modal.indexOf(">Customer receives<", pay);
    const exchange = modal.slice(pay, receive);
    expect(exchange).toContain("cd-rate-note");
    expect(exchange).toContain("RATE_NOTE");
    expect(exchange).toContain("pricedRate(amtN, out.amt, outCcy).rounded");
  });

  it("puts the same note on the customer quote", () => {
    expect(modal).toContain("rateNote:");
    expect(present).toContain("q.rateNote");
    expect(present).toContain("cd-rate-note");
  });

  it("colours the note with a theme token", () => {
    expect(receipt).not.toContain("#6B6760");
    expect(receipt).toContain("var(--faint)");
    expect(note).not.toContain("#6B6760");
    expect(note).toContain("var(--faint)");
    expect(modal).not.toContain("#6B6760");
    const ticket = modal.slice(modal.indexOf('className="cd-tx-ticket"'), modal.indexOf("margin chip"));
    expect(ticket).toContain("cd-rate-note");
    expect(ticket).not.toContain("rgba(255,255,255,0.62)");
    expect(ticket).toContain("var(--cd-on-ink-soft)");
  });

  it("does not cut the board rate to four places", () => {
    const line = modal.split("\n").find((row) => row.includes("const publishedRate"));
    expect(line).toBeTruthy();
    expect(line).not.toContain("toFixed(4)");
    expect(line).toContain("boardRateText");
  });
});
