/* The formatters the screens call, loaded the same way the page loads them:
   minor-units-format.js, then cdos-base.jsx. A direct require of the helper
   file stays green if the screen stops using it. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const babel = require(join(root, "node_modules/@babel/standalone/babel.js")) as {
  transform: (code: string, opts: { presets: string[]; filename: string }) => { code: string };
};

const read = (name: string) => readFileSync(join(root, name), "utf8");

type ScreenFns = {
  currencyPlaces: (ccy: string) => number;
  unitText: (n: number, ccy: string) => string;
  num: (n: number) => string;
  fmt: (n: number, ccy: string) => string;
  cashVariance: (counted: number, expected: number, ccy: string) => number;
  storedRoundNote: (n: number, ccy: string) => string;
  sumHomeMinor: (values: number[], places: number) => number;
};

function screen(): ScreenFns {
  const store = new Map<string, string>();
  const localStorage = new Proxy(
    {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
    },
    {
      ownKeys: () => [...store.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );
  const el = () => ({ style: {}, appendChild() {}, setAttribute() {} });
  const document = {
    documentElement: { style: {}, setAttribute() {} },
    head: { appendChild() {} },
    body: {},
    createElement: () => el(),
    getElementById: () => null,
    addEventListener() {},
  };
  const window = {
    CDOS: {} as ScreenFns,
    localStorage,
    document,
    addEventListener() {},
    dispatchEvent() {},
    matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
  };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    self: window,
    React: { useState: (v: unknown) => [v, () => {}] },
    console,
    Intl,
    Number,
    String,
    Object,
    Array,
    Math,
    JSON,
    Date,
    isNaN,
    isFinite,
    parseFloat,
    parseInt,
    setTimeout,
    clearTimeout,
    CustomEvent: class CustomEvent {},
    navigator: { language: "en-CA" },
  });
  vm.runInContext(read("os-src/minor-units-format.js"), context);
  vm.runInContext(
    babel.transform(read("os-src/cdos-base.jsx"), { presets: ["react"], filename: "cdos-base.jsx" }).code,
    context,
  );
  return window.CDOS;
}

const C = screen();
const till = read("os-src/cdos-till.jsx");
const reports = read("os-src/cdos-reports.jsx");

it("shows stored yen through the formatter the screens call", () => {
  expect(C.currencyPlaces("JPY")).toBe(0);
  expect(C.currencyPlaces("KWD")).toBe(3);
  expect(C.currencyPlaces("BHD")).toBe(3);
  expect(C.currencyPlaces("OMR")).toBe(3);
  expect(C.currencyPlaces("JOD")).toBe(3);
  expect(C.currencyPlaces("IQD")).toBe(3);
  expect(C.currencyPlaces("LYD")).toBe(3);
  expect(C.currencyPlaces("TND")).toBe(3);
  expect(C.unitText(10, "KWD")).toBe("10.000");
  expect(C.unitText(1, "KWD")).toBe("1.000");
  expect(C.unitText(10, "BHD")).toBe("10.000");
  expect(C.unitText(10, "OMR")).toBe("10.000");
  expect(C.unitText(10, "JOD")).toBe("10.000");
  expect(C.unitText(10, "IQD")).toBe("10.000");
  expect(C.unitText(10, "LYD")).toBe("10.000");
  expect(C.unitText(10, "TND")).toBe("10.000");
  expect(C.unitText(99.85, "JPY")).toBe("100");
  expect(C.unitText(489175.85, "JPY")).toBe("489,176");
});

it("keeps the currency mark on home money", () => {
  expect(C.fmt(200, "CAD")).toBe("$200.00");
  expect(C.currencyPlaces("CAD")).toBe(2);
});

it("subtracts whole-unit expected, and names a stored fraction", () => {
  expect(C.cashVariance(489176, 489175.85, "JPY")).toBe(0);
  expect(C.cashVariance(489177, 489175.85, "JPY")).toBe(1);
  expect(C.cashVariance(100, 99.5, "JPY")).toBe(0);
  expect(C.cashVariance(100, 99.85, "CAD")).toBe(0.15);
  expect(C.cashVariance(10.001, 10, "KWD")).toBe(0.001);
  expect(C.storedRoundNote(489175.85, "JPY")).toBe(
    "Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.",
  );
  expect(C.storedRoundNote(1000.5, "CAD")).toBe("");
  expect(C.storedRoundNote(99.85, "JPY")).toContain("99.85 JPY");
});

it("keeps two decimals on a whole count, and yen stays whole", () => {
  expect(C.unitText(20000, "CAD")).toBe("20,000.00");
  expect(C.unitText(5000, "USD")).toBe("5,000.00");
  expect(C.unitText(489177, "JPY")).toBe("489,177");
  /* num() drops the trailing zeros, so the wide Counted cell must not use it. */
  expect(C.num(20000)).toBe("20,000");
  expect(C.num(5000)).toBe("5,000");
  expect(till).toContain("{unitText(r.counted, r.c)}");
});

/* Per-row rounding is a different total. 4,451.104 plus 0.004 is
   4,451.10 if each row is rounded to cents first, and 4,451.11 if
   the rows are added and rounded once. */
it("rounds a home total once, after the rows are added", () => {
  const sum = C.sumHomeMinor;
  const perRow = (rows: number[]) => rows.reduce((s, n) => s + Number(n.toFixed(2)), 0);
  const dust = [4451.104, 0.004];
  expect(perRow(dust)).toBe(4451.1);
  expect(sum(dust, 2)).toBe(4451.11);
  const halves = [1.004, 1.004];
  expect(perRow(halves)).toBe(2);
  expect(sum(halves, 2)).toBe(2.01);
  expect(sum([489177 / 109.9], 2)).toBe(4451.11);
  expect(till).toContain("window.CDOS.sumHomeMinor(values, window.CDOS.displayPlaces(homeCcy))");
});

it("draws that variance and the stored line on the count, reconcile, and end of day", () => {
  expect(till).toContain("cashVariance(ccyTotal(ccy), expectedOf(ccy), ccy)");
  expect(till).toContain("cashVariance(counted, expected, c)");
  expect(till).toContain("storedRoundNote(expectedOf(ccy), ccy)");
  expect(till).toContain("storedRoundNote(r.expected, r.c)");
  expect(till).not.toContain("ccyTotal(ccy) - expectedOf(ccy)");
  expect(till).not.toContain("counted - expected");
  expect(reports).toContain("cashVariance(x.counted, x.countedExpected, x.ccy)");
  expect(reports).toContain("storedRoundNote(x.units, x.ccy)");
  expect(reports).toContain("unitText(x.units, x.ccy)");
  expect(reports).toContain('className="till-stored-row"');
  expect(reports).toContain('className="till-stored-figure"');
  expect(reports).toContain("colSpan={6}");
  expect(till).toContain("· ≈ {fmt(homeOf(ccyTotal(ccy), ccy), homeCcy)}");
});
