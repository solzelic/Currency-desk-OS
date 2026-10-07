/* A denomination line is face times quantity. Both are whole numbers of
   minor units and pieces. The product is an integer. A fraction is not
   a face and not a quantity, so it is refused rather than rounded. */
import { describe, expect, it } from "vitest";
import { buildCountSheet, countLineMinor, countSheetReply } from "../src/ledger/count-line.js";

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

  it("refuses a negative face", () => {
    expect(() => countLineMinor(-5, 1)).toThrow(/minor units/);
  });

  it("refuses a line that does not fit in a safe integer", () => {
    expect(() => countLineMinor(Number.MAX_SAFE_INTEGER, 2)).toThrow(/too large/);
  });
});

describe("a count sheet fault", () => {
  it("is not a client error when the fault is unexpected", () => {
    expect(countSheetReply(new Error("disk failed"))).toBeNull();
  });

  it("is a client error when the count itself was refused", () => {
    let refused: unknown;
    try {
      countLineMinor(-5, 1);
    } catch (error) {
      refused = error;
    }
    expect(countSheetReply(refused)).toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("a till count sheet", () => {
  const expected = {
    CAD: "25000.00",
    USD: "10.00",
    EUR: "1.00",
  };

  it("prices lines, a typed total, and the difference from the ledger balance", () => {
    const sheet = buildCountSheet({
      lines: [{ currency: "CAD", faceMinor: 5, quantity: 3 }],
      typed: [{ currency: "USD", amount: "200.00" }],
      expected,
    });
    expect(sheet.lines).toEqual([
      { currency: "CAD", faceMinor: 5, quantity: 3, minor: 15 },
    ]);
    expect(sheet.currencies).toEqual([
      { currency: "CAD", counted: "0.15", expected: "25000.00", variance: "-24999.85" },
      { currency: "EUR", counted: null, expected: "1.00", variance: null },
      { currency: "USD", counted: "200.00", expected: "10.00", variance: "190.00" },
    ]);
  });

  it("leaves the difference absent when the ledger has no balance", () => {
    const sheet = buildCountSheet({
      lines: [{ currency: "PHP", faceMinor: 100, quantity: 2 }],
      typed: [],
      expected: {},
    });
    expect(sheet.currencies).toEqual([
      { currency: "PHP", counted: "2.00", expected: null, variance: null },
    ]);
  });

  it("refuses a currency listed twice", () => {
    expect(() => buildCountSheet({
      lines: [],
      typed: [
        { currency: "CAD", amount: "1.00" },
        { currency: "CAD", amount: "2.00" },
      ],
      expected: {},
    })).toThrow(/listed twice/);
  });

  it("refuses a currency counted both by denomination and as one total", () => {
    expect(() => buildCountSheet({
      lines: [{ currency: "CAD", faceMinor: 100, quantity: 1 }],
      typed: [{ currency: "CAD", amount: "1.00" }],
      expected: {},
    })).toThrow(/not both/);
  });
});
