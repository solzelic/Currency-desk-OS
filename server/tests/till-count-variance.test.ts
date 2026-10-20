/* The variance written on a count. Same roundTo as a yen payout.
   A two-decimal figure is unchanged. KWD stays at three places, so a
   half-fils expected is not collapsed to two before the subtraction. */
import { expect, it } from "vitest";
import { recordedVariance } from "../src/ledger/till-control.js";
import { screen } from "./screen-format.js";

const shown = screen();

it("rounds the expected with the currency, then subtracts", () => {
  expect(recordedVariance("489176.00", "489175.85", "JPY")).toBe("0.00");
  expect(recordedVariance("489177.00", "489175.85", "JPY")).toBe("1.00");
  expect(recordedVariance("100.00", "99.85", "CAD")).toBe("0.15");
  expect(recordedVariance("1.24", "1.23", "KWD")).toBe("0.01");
  expect(recordedVariance("1.23", "1.225", "KWD")).toBe("0.01");
});

it("matches the variance the count screen draws", () => {
  expect(Number(recordedVariance("489176.00", "489175.85", "JPY"))).toBe(
    shown.cashVariance(489176, 489175.85, "JPY"),
  );
  expect(Number(recordedVariance("489177.00", "489175.85", "JPY"))).toBe(
    shown.cashVariance(489177, 489175.85, "JPY"),
  );
  expect(Number(recordedVariance("100.00", "99.85", "CAD"))).toBe(
    shown.cashVariance(100, 99.85, "CAD"),
  );
});
