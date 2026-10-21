/* Loads the formatters the screens call: minor-units-format.js, then
   cdos-base.jsx. Shared so a saved variance can be checked against the
   number the count screen draws. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const babel = require(join(root, "node_modules/@babel/standalone/babel.js")) as {
  transform: (code: string, opts: { presets: string[]; filename: string }) => { code: string };
};

const read = (name: string) => readFileSync(join(root, name), "utf8");

export function screen() {
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
    CDOS: {} as Record<string, (...args: never[]) => unknown>,
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
  return window.CDOS as {
    currencyPlaces: (ccy: string) => number;
    unitText: (n: number, ccy: string) => string;
    num: (n: number) => string;
    fmt: (n: number, ccy: string) => string;
    cashVariance: (counted: number, expected: number, ccy: string) => number;
    storedRoundNote: (n: number, ccy: string) => string;
    sumHomeMinor: (values: number[], places: number) => number;
  };
}
