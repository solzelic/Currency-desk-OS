import { describe, expect, it } from "vitest";
import { civilDate, civilToday } from "../src/civil-date.js";

/* The driver builds a date column as local midnight. Formatting that
   instant with toISOString() is the previous civil day in Asia/Jerusalem
   and Pacific/Auckland. A YYYY-MM-DD string parsed as UTC midnight is
   the previous local day in America/Toronto.

   Reverting civilDate to toISOString().slice(0, 10) makes the Date
   assertion fail in those east-of-UTC zones. The string assertion fails
   in America/Toronto if the string is parsed as UTC midnight and then
   read with local calendar fields. */
describe("civil dates", () => {
  it("keeps a calendar day when the process zone is not UTC", () => {
    expect(civilDate(new Date(2030, 3, 1))).toBe("2030-04-01");
    expect(civilDate("2030-04-01")).toBe("2030-04-01");
    expect(civilDate("1979-03-04T00:00:00.000Z")).toBe("1979-03-04");
    expect(civilDate(null)).toBeNull();
    expect(civilDate("")).toBeNull();
    expect(civilToday(new Date(2030, 3, 1, 15, 2))).toBe("2030-04-01");
  });

  it("refuses a value that is not a calendar day", () => {
    expect(() => civilDate("not-a-date")).toThrow(/civil date/);
    expect(() => civilDate(new Date("nope"))).toThrow(/Invalid date/);
  });
});
