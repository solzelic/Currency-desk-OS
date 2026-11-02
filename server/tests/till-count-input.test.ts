/* A till count reads exactly what the teller typed or pasted, or refuses it.
   It never rounds and never reads a look-alike character as a digit (#558).
   The rules are parseCount and countPieces in os-src/minor-units-format.js,
   the file the desk loads; the server checks the same shape again in
   server/src/ledger/routes.ts (countAmount, then the currency's minor unit). */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isoMinorUnits, LEDGER_SCALE, minorUnits } from "../src/ledger/currencies.js";
import { INDICATIVE_PER_CAD } from "../src/rates/starting-board.js";

type Read = { ok: true; value: string } | { ok: false; reason: string };

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const units = require(join(root, "os-src/minor-units-format.js")) as {
  parseCount: (text: unknown, currency: string) => Read;
  countPlaces: (currency: string) => number;
  countPieces: (rows: [number, unknown][], currency: string) => Read;
};
const { parseCount, countPlaces, countPieces } = units;
const displayPlaces = (units as unknown as { displayPlaces: (c: string) => number }).displayPlaces;

const refused = (text: string, currency: string) => {
  const result = parseCount(text, currency);
  expect(result.ok, `${currency} ${JSON.stringify(text)}`).toBe(false);
  return result.ok ? "" : result.reason;
};
const read = (text: string, currency: string) => {
  const result = parseCount(text, currency);
  expect(result, `${currency} ${JSON.stringify(text)}`).toMatchObject({ ok: true });
  return result.ok ? result.value : "";
};

describe("a till count as typed", () => {
  it("refuses 1.999 CAD and says why, instead of sending 2.00", () => {
    expect(refused("1.999", "CAD")).toBe("CAD takes 2 decimal places. You typed 1.999. Remove the extra digit to save.");
    expect(refused("24990.0049", "CAD")).toBe("CAD takes 2 decimal places. You typed 24990.0049. Remove the extra digits to save.");
  });

  it("refuses a pasted 1500² instead of reading it as 15002", () => {
    expect(refused("1500²", "CAD")).toBe("Type the CAD count with the digits 0 to 9 and one decimal point.");
    expect(refused("¹⁵⁰⁰", "CAD")).toContain("digits 0 to 9");
  });

  it("refuses full-width, Arabic-Indic and subscript digits rather than converting them", () => {
    refused("１５００", "CAD");
    refused("١٥٠٠", "CAD");
    refused("1500₂", "CAD");
    refused("₁₅₀₀", "CAD");
  });

  it("refuses every other character that is not a digit or one decimal point", () => {
    for (const text of ["1500a", "15 00", "1.5.0", "-20", "+20", "1e3", "$1500", "Infinity", "."]) {
      expect(refused(text, "CAD"), text).toBe("Type the CAD count with the digits 0 to 9 and one decimal point.");
    }
  });

  it("refuses every comma, and reads none of them as a thousands mark", () => {
    for (const text of ["1,500", "1,500.25", "0,500", "00,500", "000,500", "1500,7", "1,50", ",500", ",", "12,345,678"]) {
      expect(refused(text, "CAD"), text).toBe(`CAD amounts are typed without commas. You typed ${text}. Remove the commas to save.`);
    }
    expect(refused("1,500", "JPY")).toBe("JPY amounts are typed without commas. You typed 1,500. Remove the commas to save.");
    expect(refused(" 1,500 ", "CAD")).toBe("CAD amounts are typed without commas. You typed 1,500. Remove the commas to save.");
  });

  it("refuses a European 1.500,25, an Arabic or full-width comma, a thin space and a sign", () => {
    for (const text of ["1.500,25", "1\u060C500", "1500\u060C25", "1\uFF0C500"]) {
      expect(refused(text, "CAD"), JSON.stringify(text)).toBe(`CAD amounts are typed without commas. You typed ${text}. Remove the commas to save.`);
    }
    for (const text of ["1\u2009500", "1\u2009500.25", "+1500", "-1500", "+1500.00", "-0"]) {
      expect(refused(text, "CAD"), JSON.stringify(text)).toBe("Type the CAD count with the digits 0 to 9 and one decimal point.");
    }
  });

  it("refuses a decimal on a currency with no minor unit", () => {
    expect(refused("1500.5", "JPY")).toBe("JPY has no decimal places. Count whole JPY.");
    expect(refused("1500.", "JPY")).toBe("JPY has no decimal places. Count whole JPY.");
  });

  it("counts to the places the till can hold: two, or none", () => {
    expect(countPlaces("CAD")).toBe(2);
    expect(countPlaces("JPY")).toBe(0);
    expect(countPlaces("KWD")).toBe(2);
    expect(refused("1.500", "KWD")).toBe("KWD takes 2 decimal places. You typed 1.500. Remove the extra digit to save.");
    expect(read("1.50", "KWD")).toBe("1.50");
  });

  it("refuses an empty count and an amount the ledger cannot hold", () => {
    expect(refused("", "CAD")).toBe("Type the CAD count.");
    expect(refused("   ", "CAD")).toBe("Type the CAD count.");
    expect(refused("1000000000.01", "CAD")).toBe("CAD 1000000000.01 is more than a till can hold. Check the count and type it again.");
    expect(refused("99999999999", "JPY")).toBe("JPY 99999999999 is more than a till can hold. Check the count and type it again.");
  });

  it("reads what was typed exactly, padded to the currency's places and never rounded", () => {
    expect(read("1.99", "CAD")).toBe("1.99");
    expect(read("1.9", "CAD")).toBe("1.90");
    expect(read("1.5", "CAD")).toBe("1.50");
    expect(read("1500", "CAD")).toBe("1500.00");
    expect(read(" 1500 ", "CAD")).toBe("1500.00");
    expect(read("0012.30", "CAD")).toBe("12.30");
    expect(read(".5", "CAD")).toBe("0.50");
    expect(read("5.", "CAD")).toBe("5.00");
    expect(read("0", "CAD")).toBe("0.00");
    expect(read("1500", "JPY")).toBe("1500");
    expect(read("1000000000", "CAD")).toBe("1000000000.00");
  });
});

describe("a count by denomination", () => {
  it("adds pieces in whole minor units, so the total is exact", () => {
    expect(countPieces([[20, "2"], [0.05, "3"], [0.1, "1"]], "CAD")).toEqual({ ok: true, value: "40.25" });
    expect(countPieces([[0.1, "3"], [0.2, "1"]], "CAD")).toEqual({ ok: true, value: "0.50" });
    expect(countPieces([[1000, "4"], [500, ""]], "JPY")).toEqual({ ok: true, value: "4000" });
    expect(countPieces([], "CAD")).toEqual({ ok: true, value: "0.00" });
  });

  it("refuses a total over the cap in the same words", () => {
    expect(countPieces([[100, "10000001"]], "CAD")).toEqual({
      ok: false,
      reason: "CAD 1000000100.00 is more than a till can hold. Check the count and type it again.",
    });
  });

  it("refuses a piece count that is not whole digits", () => {
    for (const pieces of ["5²", "2.5", "-1", "+1", "１", "3 ", "1,000", "1\u2009000"]) {
      expect(countPieces([[20, pieces]], "CAD"), JSON.stringify(pieces)).toEqual({
        ok: false,
        reason: "Count CAD pieces with the digits 0 to 9.",
      });
    }
  });
});

/* The places a count may carry are the places the server's ledger takes
   for that currency: its ISO minor units, capped at the ledger's scale
   (numeric(24,2)). Every currency the server names is checked, so a code
   added to server/src/ledger/currencies.ts and not to the client table
   fails here, not on a teller's close. */
describe("the client's count places match the server's currencies", () => {
  const codes = [...new Set([...Object.keys(isoMinorUnits()), ...Object.keys(INDICATIVE_PER_CAD), "CAD", "USD", "EUR", "GBP"])].sort();

  it("walks every currency the server knows", () => {
    expect(codes.length).toBeGreaterThan(30);
    for (const code of Object.keys(isoMinorUnits())) expect(codes).toContain(code);
  });

  it.each(codes)("%s counts to the places the ledger stores", (code) => {
    expect(displayPlaces(code), `${code} screen places`).toBe(minorUnits(code));
    expect(countPlaces(code), `${code} count places`).toBe(Math.min(minorUnits(code), LEDGER_SCALE));
  });
});
