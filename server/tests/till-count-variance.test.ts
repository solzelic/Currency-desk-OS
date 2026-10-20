/* The variance written on a count. It calls roundTo. That function is
   the one rounding rule: half up, by the currency's minor units. */
import Decimal from "decimal.js";
import { expect, it } from "vitest";
import { minorUnits, roundTo } from "../src/ledger/currencies.js";
import { recordedVariance } from "../src/ledger/till-control.js";
import { screen } from "./screen-format.js";

const shown = screen();

it("rounds the expected with the currency, then subtracts", () => {
  expect(recordedVariance("489176.00", "489175.85", "JPY")).toBe("0.00");
  expect(recordedVariance("489177.00", "489175.85", "JPY")).toBe("1.00");
  expect(recordedVariance("100.00", "99.85", "CAD")).toBe("0.15");
  expect(recordedVariance("1.24", "1.23", "KWD")).toBe("0.01");
  expect(recordedVariance("1.23", "1.225", "KWD")).toBe("0.01");
  expect(recordedVariance("489175.00", "489175.85", "JPY")).toBe("-1.00");
});

it("rounds half a minor unit up, and keeps a whole unit short", () => {
  expect(roundTo(new Decimal("100.5"), "JPY").toFixed(0)).toBe("101");
  expect(recordedVariance("101.00", "100.50", "JPY")).toBe("0.00");
  expect(recordedVariance("100.00", "100.50", "JPY")).toBe("-1.00");
  expect(roundTo(new Decimal("1.005"), "CAD").toFixed(2)).toBe("1.01");
  expect(recordedVariance("1.00", "1.005", "CAD")).toBe("-0.01");
  expect(roundTo(new Decimal("1.2255"), "KWD").toFixed(3)).toBe("1.226");
  for (const [expected, currency] of [
    ["489175.85", "JPY"],
    ["100.50", "JPY"],
    ["1.005", "CAD"],
    ["1.2255", "KWD"],
  ] as const) {
    const raw = new Decimal(expected);
    const absorbed = raw.minus(roundTo(raw, currency)).abs();
    const unit = new Decimal(10).pow(-minorUnits(currency));
    expect(absorbed.lt(unit), `${currency} absorbed ${absorbed}`).toBe(true);
  }
});

it("matches the variance the count screen draws", () => {
  expect(Number(recordedVariance("101.00", "100.50", "JPY"))).toBe(
    shown.cashVariance(101, 100.5, "JPY"),
  );
  expect(Number(recordedVariance("489176.00", "489175.85", "JPY"))).toBe(
    shown.cashVariance(489176, 489175.85, "JPY"),
  );
  expect(Number(recordedVariance("489177.00", "489175.85", "JPY"))).toBe(
    shown.cashVariance(489177, 489175.85, "JPY"),
  );
  expect(Number(recordedVariance("100.00", "99.85", "CAD"))).toBe(
    shown.cashVariance(100, 99.85, "CAD"),
  );
  expect(Number(recordedVariance("489175.00", "489175.85", "JPY"))).toBe(
    shown.cashVariance(489175, 489175.85, "JPY"),
  );
  expect(shown.cashVariance(101, 100.5, "JPY")).toBe(0);
});
