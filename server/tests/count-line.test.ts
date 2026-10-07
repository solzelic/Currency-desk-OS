/* A denomination line is face times quantity. Both are whole numbers of
   minor units and pieces. The product is an integer. A fraction is not
   a face and not a quantity, so it is refused rather than rounded. */
import { describe, expect, it } from "vitest";
import { countLineMinor } from "../src/ledger/count-line.js";

describe("a till count line", () => {
  it("totals three five-cent coins as 15 minor units", () => {
    expect(countLineMinor(5, 3)).toBe(15);
  });

  it("totals two hundred-dollar bills as 20000 minor units", () => {
    expect(countLineMinor(10000, 2)).toBe(20000);
  });

  it("refuses a fractional face", () => {
    expect(() => countLineMinor(0.05, 3)).toThrow(/minor units/);
  });

  it("refuses a fractional quantity", () => {
    expect(() => countLineMinor(5, 1.5)).toThrow(/pieces/);
  });
});
