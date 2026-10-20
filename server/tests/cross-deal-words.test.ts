import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const React = require("react") as { createElement: (...args: unknown[]) => unknown };
const { renderToStaticMarkup } = require("react-dom/server") as {
  renderToStaticMarkup: (node: unknown) => string;
};
const { transform } = require("@babel/standalone") as {
  transform: (src: string, opts: object) => { code: string | null };
};

/* A posted cross arrives with side "buy" unless the pay-in is CAD.
   The words have to follow the two currencies and the home currency. */
const base = {
  type: "Currency Exchange",
  inAmt: "100000",
  outAmt: "1179.36",
  rate: "0.0117936",
  fee: 0,
  date: "2026-10-20",
  teller: "M",
  ref: "LT",
  customer: "A. Shah",
};

function loadJsx(file: string, patch?: (src: string) => string) {
  const rate = require(join(root, "os-src/effective-rate.js")) as Record<string, unknown>;
  const api: Record<string, unknown> = { ...rate };
  try {
    Object.assign(api, require(join(root, "os-src/deal-words.js")) as Record<string, unknown>);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (code !== "MODULE_NOT_FOUND") throw err;
  }
  const CD = new Proxy({}, { get: (_t, key) => "tok-" + String(key) });
  const CDOS = new Proxy(api, {
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
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.React = React;
  g.document = document;
  let src = readFileSync(join(root, file), "utf8");
  if (patch) src = patch(src);
  const code = transform(src, { presets: ["react"], filename: file }).code;
  if (!code) throw new Error(file);
  new Function("React", "ReactDOM", "window", "document", code)(React, {}, window, document);
  return CDOS as {
    ReceiptModal: (props: unknown) => unknown;
    TxFlow: (props: unknown) => unknown;
    TxFacts: (props: unknown) => unknown;
  };
}

const modules = loadJsx("os-src/cdos-modules.jsx");
const ledger = loadJsx("os-src/cdos-ledger.jsx", (src) => src.replace(
  "{ Ledger, TxModal, TxDetail, Tagged }",
  "{ Ledger, TxModal, TxDetail, Tagged, TxFlow, TxFacts }",
));

function draw(fn: (props: unknown) => unknown, props: unknown) {
  return renderToStaticMarkup(React.createElement(fn as never, props));
}
function row(over: Record<string, string>) {
  return { ...base, ...over };
}
function afterLabel(html: string, label: string): string {
  const token = ">" + label + "</span>";
  const at = html.indexOf(token);
  if (at < 0) return "";
  const match = html.slice(at + token.length).match(/<span[^>]*>([^<]*)<\/span>/);
  return match && match[1] ? match[1] : "";
}
function dealLine(html: string): string {
  const subs = [...html.matchAll(/mt-0\.5 truncate"[^>]*>([^<]*)</g)].map((m) => m[1] || "");
  return subs.filter((s) => s !== base.customer).join(" | ");
}
function surfaces(over: Record<string, string>) {
  const data = row(over);
  return {
    receipt: afterLabel(draw(modules.ReceiptModal, { row: data, onClose() {}, settings: {} }), "Pricing"),
    deal: dealLine(draw(ledger.TxFlow, { row: data })),
    ledger: afterLabel(draw(ledger.TxFacts, { row: data, onOpenClient() {} }), "Priced"),
  };
}

describe("cross deal words", () => {
  it("renders both currencies on the receipt, the deal row, and the ledger row", () => {
    const inr = surfaces({ inCcy: "INR", outCcy: "USD", side: "buy", priced: "override" });
    const usd = surfaces({ inCcy: "USD", outCcy: "INR", side: "buy" });
    expect({
      inrReceipt: inr.receipt,
      inrDeal: inr.deal,
      inrLedger: inr.ledger,
      usdReceipt: usd.receipt,
      usdDeal: usd.deal,
      usdLedger: usd.ledger,
    }).toEqual({
      inrReceipt: "We bought INR, sold USD",
      inrDeal: "Bought INR, sold USD",
      inrLedger: "Bought INR, sold USD · hand-priced",
      usdReceipt: "We bought USD, sold INR",
      usdDeal: "Bought USD, sold INR",
      usdLedger: "Bought USD, sold INR",
    });
  });

  it("keeps the home-currency sentences", () => {
    const sold = surfaces({ inCcy: "CAD", outCcy: "USD", side: "sell", priced: "locked" });
    const bought = surfaces({ inCcy: "USD", outCcy: "CAD", side: "buy" });
    expect({
      soldReceipt: sold.receipt,
      soldDeal: sold.deal,
      soldLedger: sold.ledger,
      boughtReceipt: bought.receipt,
      boughtDeal: bought.deal,
      boughtLedger: bought.ledger,
    }).toEqual({
      soldReceipt: "We sold USD",
      soldDeal: "Sold USD",
      soldLedger: "We sold USD · rate locked",
      boughtReceipt: "We bought USD",
      boughtDeal: "Bought USD",
      boughtLedger: "We bought USD",
    });
  });
});
