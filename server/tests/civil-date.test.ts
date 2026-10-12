import { describe, expect, it } from "vitest";
import { civilDate, civilToday, tillBusinessDate } from "../src/civil-date.js";

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

  /* open() stores tillBusinessDate(now) on the till session.
     00:30 local on 2 Jan 2026 is still 1 Jan in UTC wherever the process
     is east of UTC. Asia/Jerusalem prints 2026-01-01 from toISOString().
     Returning that UTC day fails this test. The civil-dates job runs it
     under Asia/Jerusalem. */
  it("dates a till opened at 00:30 local on the local day", () => {
    const opened = new Date(2026, 0, 2, 0, 30);
    expect(tillBusinessDate(opened)).toBe("2026-01-02");
  });

  /* Leap day, and the 2026 days the clocks change.
     America/Toronto moves forward on 8 Mar 2026 and back on 1 Nov 2026.
     Asia/Jerusalem moves forward on 27 Mar 2026 and back on 25 Oct 2026.
     00:30 local is the previous UTC day under Asia/Jerusalem, including
     on 29 Feb 2024. A UTC slice fails these there. The 02:30 and 01:30
     instants are the spring gap and the fall overlap. */
  it("keeps leap day and the 2026 daylight saving days", () => {
    expect(civilToday(new Date(2024, 1, 29, 0, 30))).toBe("2024-02-29");
    expect(civilDate(new Date(2024, 1, 29))).toBe("2024-02-29");
    expect(civilToday(new Date(2026, 2, 8, 0, 30))).toBe("2026-03-08");
    expect(civilToday(new Date(2026, 2, 8, 2, 30))).toBe("2026-03-08");
    expect(civilToday(new Date(2026, 10, 1, 0, 30))).toBe("2026-11-01");
    expect(civilToday(new Date(2026, 10, 1, 1, 30))).toBe("2026-11-01");
    expect(civilToday(new Date(2026, 2, 27, 0, 30))).toBe("2026-03-27");
    expect(civilToday(new Date(2026, 2, 27, 2, 30))).toBe("2026-03-27");
    expect(civilToday(new Date(2026, 9, 25, 0, 30))).toBe("2026-10-25");
    expect(civilToday(new Date(2026, 9, 25, 1, 30))).toBe("2026-10-25");
  });
});
