import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { displayPlaces, roundMinor, unitAmount, moneyAmount } = require(
  join(root, "os-src/minor-units-format.js"),
) as {
  displayPlaces: (code: string, scales: Record<string, number> | null) => number;
  roundMinor: (n: number, places: number) => number;
  unitAmount: (n: number | string, code: string, scales: Record<string, number> | null) => string;
  moneyAmount: (n: number | string, code: string, scales: Record<string, number> | null) => string;
};

const read = (name: string) => readFileSync(join(root, name), "utf8");

it("shows a stored two-place yen figure as whole units", () => {
  expect(displayPlaces("JPY", { JPY: 0 })).toBe(0);
  expect(unitAmount("200.80", "JPY", { JPY: 0 })).toBe("201");
  expect(unitAmount("200.00", "JPY", { JPY: 0 })).toBe("200");
  expect(unitAmount("200.80", "JPY", null)).toBe("201");
});

it("caps a three-decimal currency at two places", () => {
  expect(displayPlaces("KWD", { KWD: 3 })).toBe(2);
  expect(displayPlaces("KWD", null)).toBe(2);
  expect(unitAmount(1.235, "KWD", { KWD: 3 })).toBe("1.24");
  expect(unitAmount(1.235, "KWD", null)).toBe("1.24");
});

it("rounds the till expected figure and the count difference to minor units", () => {
  expect(unitAmount(99.85, "JPY", { JPY: 0 })).toBe("100");
  expect(roundMinor(0.15000000002328306, 0)).toBe(0);
  expect(roundMinor(100 - 99.85, 0)).toBe(0);
  expect(roundMinor(0.15000000000000568, 2)).toBe(0.15);
  expect(unitAmount(0.15, "CAD", { CAD: 2 })).toBe("0.15");
});

it("formats home currency before the scales table loads", () => {
  expect(displayPlaces("CAD", null)).toBe(2);
  expect(displayPlaces("INR", null)).toBe(2);
  expect(displayPlaces("KRW", null)).toBe(0);
  expect(moneyAmount(200, "CAD", null)).toBe("$200.00");
});

it("draws the till expected figure and the difference through those places", () => {
  const till = read("os-src/cdos-till.jsx");
  const base = read("os-src/cdos-base.jsx");
  expect(till).toContain("unitText(expectedOf(ccy), ccy)");
  expect(till).toContain("roundMinor(ccyTotal(ccy) - expectedOf(ccy), currencyPlaces(ccy))");
  expect(till).toContain("roundMinor(counted - expected, currencyPlaces(c))");
  expect(till).toContain("unitText(r.expected, r.c)");
  expect(till).not.toContain("storedText(expectedOf(ccy), ccy)");
  expect(till).not.toContain("storedText(v, ccy)");
  expect(base).toContain("displayPlaces(code, _currencies && _currencies.scales)");
  expect(base).not.toContain("if (!scales) return null");
  expect(read("CurrencyDesk OS.html")).toContain('src="os-src/minor-units-format.js"');
});
