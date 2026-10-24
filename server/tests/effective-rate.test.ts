import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { effectiveRate, exactRateText, boardRateText, MIN_RATE_PLACES, MAX_RATE_PLACES, RATE_NOTE } = require(
  join(root, "os-src/effective-rate.js"),
) as {
  effectiveRate: (amount: string, payout: string, places: number | null) => { text: string; rounded: boolean };
  exactRateText: (rate: string) => string;
  boardRateText: (rate: number) => string;
  MIN_RATE_PLACES: number;
  MAX_RATE_PLACES: number;
  RATE_NOTE: string;
};

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
    expect(RATE_NOTE).toBe("Rate shown rounded. Amounts use the exact rate.");
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
    expect(RATE_NOTE).toBe("Rate shown rounded. Amounts use the exact rate.");
    expect(exactRateText("0.722103704355")).toBe("0.722104");
  });

  it("returns no figure before the scale is known", () => {
    expect(effectiveRate("100.00", "10825", null)).toEqual({ text: "", rounded: false });
  });

  it("keeps 1,234.5 INR at one decimal and does not round 0.0118 to 0.01", () => {
    expect(`${num(1234.5)} INR`).toBe("1,234.5 INR");
    expect(num(0.0118)).toBe("0.01");
    const exact = effectiveRate("100.00", "1.18", 2);
    expect(exact).toEqual({ text: "0.0118", rounded: false });
    expect(`1 INR = ${exact.text} USD`).toBe("1 INR = 0.0118 USD");
    expect(exact.text).not.toBe("0.01");
    const rounded = effectiveRate("1234.5", "14.57", 2);
    expect(rounded).toEqual({ text: "0.0118", rounded: true });
    expect(`1 INR = ${rounded.text} USD`).toBe("1 INR = 0.0118 USD");
    expect(RATE_NOTE).toBe("Rate shown rounded. Amounts use the exact rate.");
  });

  it("keeps four significant digits on a small rate", () => {
    const krw = effectiveRate("1000000.00", "725.40", 2);
    expect(krw).toEqual({ text: "0.0007254", rounded: false });
    expect(krw.text).not.toBe("0.0007");
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
    const rate = effectiveRate("3000.00", "2166.46", 2);
    expect(rate).toEqual({ text: "0.7222", rounded: true });
    expect(rate.text).not.toBe("0.7221");
  });
});


const React = require("react") as { createElement: (...args: unknown[]) => unknown };
const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
const { transform } = require("@babel/standalone") as { transform: (src: string, opts: object) => { code: string | null } };

function loadJsx(file: string, patch?: (src: string) => string) {
  const real = require(join(root, "os-src/effective-rate.js")) as Record<string, unknown>;
  const CD = new Proxy({}, { get: (_t, key) => "tok-" + String(key) });
  const CDOS = new Proxy(real, {
    get(target, key) {
      if (key in target) return target[key as keyof typeof target];
      if (key === "CD") return CD;
      if (key === "currencyPlaces") return () => 2;
      if (key === "num" || key === "fmt") return (n: unknown) => String(n ?? "");
      if (key === "deskPack") return () => ({ homeCurrency: "CAD" });
      if (key === "reportingLimit") return () => ({});
      if (key === "CCY" || key === "TYPES" || key === "SEARCH_EXAMPLES") return [];
      if (key === "Ic" || key === "CommitBtn" || key === "Absent") return () => null;
      return () => 0;
    },
  });
  const window = { CDOS };
  const document = { addEventListener() {}, removeEventListener() {}, body: {}, activeElement: null };
  const ReactDOM = { createPortal: (node: unknown) => node };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.React = React;
  g.ReactDOM = ReactDOM;
  g.document = document;
  let src = readFileSync(join(root, file), "utf8");
  if (patch) src = patch(src);
  const code = transform(src, { presets: ["react"], filename: file }).code;
  if (!code) throw new Error(file);
  new Function("React", "ReactDOM", "window", "document", code)(React, ReactDOM, window, document);
  return CDOS;
}

function lum(hex: string): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [0, 1, 2].reduce((sum, i) => sum + [0.2126, 0.7152, 0.0722][i]! * lin(parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255), 0);
}
function ratio(a: string, b: string): number {
  return (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
}
function theme(name: string): (key: string) => string {
  const src = readFileSync(join(root, "os-src/cdos-base.jsx"), "utf8");
  const at = src.indexOf(name + ": {");
  const block = src.slice(at, src.indexOf("\n    }", at));
  return (key) => {
    const hit = block.match(new RegExp(key + ": '(#[0-9A-Fa-f]{6})'"));
    if (!hit || !hit[1]) throw new Error(name + " " + key);
    return hit[1];
  };
}
function noteOnPaper(html: string, paper: string): string {
  const color = html.match(/cd-rate-note" style="[^"]*color:([^;"]+)/)?.[1] || "";
  const pinned = html.indexOf("cd-paper-island") >= 0 && html.indexOf("cd-rate-note") > html.indexOf("cd-paper-island");
  if (color === "var(--cd-pin-note)") return theme(pinned ? "light" : "dark")("pinNote");
  const css = readFileSync(join(root, "os-src/york-os.css"), "utf8");
  const hit = css.slice(css.indexOf('html[data-cdtheme="dark"]')).match(/--faint:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
  if (!hit) throw new Error(color || "receipt note");
  const hex = "#" + [hit[1], hit[2], hit[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const alpha = Number(hit[4]);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(hex, i) * alpha + ch(paper, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}

const inr = {
  inCcy: "INR", outCcy: "USD", inAmt: "1234.5", outAmt: "14.57", rate: "0.011802348123",
  type: "Currency Exchange", fee: 0, date: "2026-10-20", teller: "M", ref: "LT",
};

describe("rendered rate", () => {
  const modules = loadJsx("os-src/cdos-modules.jsx");
  const ledger = loadJsx("os-src/cdos-ledger.jsx", (src) => src.replace(
    "{ Ledger, TxModal, TxDetail, Tagged }",
    "{ Ledger, TxModal, TxDetail, Tagged, RateNote, shownDealRate }",
  ));
  const modal = loadJsx("os-src/cdos-txmodal.jsx", (src) => src.replace(
    "{ TxModal }",
    "{ TxModal, PresentQuote, SheetRateNote }",
  ));
  const draw = (fn: unknown, props: unknown) => renderToStaticMarkup(React.createElement(fn as never, props));
  const withRow = (over: Record<string, string>) => ({ ...inr, ...over });

  it("prints the effective rate on the receipt, not the stored rate", () => {
    const html = draw(modules.ReceiptModal, { row: inr, onClose() {}, settings: {} });
    expect(html).toContain("1 INR = 0.0118 USD");
    expect(html).not.toContain("0.011802348123");
    expect(html).toContain(RATE_NOTE);
    const quiet = draw(modules.ReceiptModal, { row: withRow({ inAmt: "100.00", outAmt: "1.18" }), onClose() {}, settings: {} });
    expect(quiet).toContain("1 INR = 0.0118 USD");
    expect(quiet).not.toContain("cd-rate-note");
  });

  it("prints the deal and the quote note only when the rate was rounded", () => {
    const shown = ledger.shownDealRate as (row: typeof inr) => string;
    expect(shown(inr)).toBe("1 INR = 0.0118 USD");
    expect(draw(ledger.RateNote, { row: inr })).toContain(RATE_NOTE);
    expect(draw(ledger.RateNote, { row: withRow({ inAmt: "100.00", outAmt: "1.18" }) })).toBe("");
    expect(draw(modal.SheetRateNote, { on: true })).toContain("var(--cd-pin-note)");
    expect(draw(modal.SheetRateNote, { on: false })).toBe("");
    const quote = {
      biz: "York", title: "Quote", tag: "CAD", giveLbl: "You give", give: "1",
      rateLine: "1 CAD = 0.7221 USD", rateNote: RATE_NOTE, getLbl: "You receive", get: "2", foot: "no fee",
    };
    expect(draw(modal.PresentQuote, { q: quote, onClose() {} })).toContain("cd-rate-note");
    expect(draw(modal.PresentQuote, { q: { ...quote, rateNote: "" }, onClose() {} })).not.toContain("cd-rate-note");
  });

  it("clears 4.5:1 on the sheet, the receipt paper, and the ink", () => {
    for (const name of ["light", "dark"]) {
      const tone = theme(name);
      expect(ratio(tone("pinNote"), tone("panel"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tone("pinNote"), tone("chip"))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tone("noteOnInk"), tone("ink"))).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(theme("dark")("pinNote"), theme("light")("panel"))).toBeLessThan(4.5);
    const html = draw(modules.ReceiptModal, { row: inr, onClose() {}, settings: {} });
    const paper = theme("light")("panel");
    expect(ratio(noteOnPaper(html, paper), paper)).toBeGreaterThanOrEqual(4.5);
  });
});
