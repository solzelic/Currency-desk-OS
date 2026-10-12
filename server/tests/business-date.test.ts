/* The trading day is a calendar date in the branch zone.

   These pin the two places it used to move. `toISOString().slice(0, 10)`
   on a clock just after midnight in Jerusalem is still the previous UTC
   day. node-pg then parses a DATE as local midnight, and the same slice
   moves it again wherever the process zone is ahead of UTC. The sign-off
   sheet was reading that shifted date and asking for a window that did
   not contain the deal. */
import { describe, expect, it } from "vitest";
import {
  businessDate,
  calendarBefore,
  calendarDaysUntil,
  readDateOnly,
  refDay,
  signOffWindow,
  zonedMidnight,
} from "../src/ledger/business-date.js";
import { assertBranchTimeZone, BranchTimeZoneUnset } from "../src/ledger/branch-zone.js";

describe("businessDate", () => {
  it("is the branch calendar date just after midnight in Jerusalem", () => {
    const at = new Date("2026-10-12T00:30:00+03:00");
    expect(businessDate(at, "Asia/Jerusalem")).toBe("2026-10-12");
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-11");
  });

  it("is the branch calendar date just after midnight in Toronto", () => {
    const at = new Date("2026-10-12T00:30:00-04:00");
    expect(businessDate(at, "America/Toronto")).toBe("2026-10-12");
  });

  it("stays on the Toronto date when UTC has already rolled over", () => {
    const at = new Date("2026-10-11T23:30:00-04:00");
    expect(businessDate(at, "America/Toronto")).toBe("2026-10-11");
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-12");
  });

  it("stamps a reference from the calendar date, not from an instant", () => {
    expect(refDay("2026-10-12")).toBe("261012");
    expect(refDay(readDateOnly(new Date(2026, 9, 12)))).toBe("261012");
  });

  it("rejects a clock or a zone it cannot read", () => {
    expect(() => businessDate(new Date(NaN), "Asia/Jerusalem")).toThrow(/real instant/);
    expect(() => businessDate(new Date(), "Not/AZone")).toThrow();
  });
});

describe("readDateOnly", () => {
  it("keeps the calendar fields node-pg stored, not the UTC shift", () => {
    const stored = new Date(2026, 9, 12, 0, 0, 0);
    const calendar = `${stored.getFullYear()}-${String(stored.getMonth() + 1).padStart(2, "0")}-${String(stored.getDate()).padStart(2, "0")}`;
    expect(readDateOnly(stored)).toBe(calendar);
    expect(readDateOnly("2026-10-12")).toBe("2026-10-12");
    const utc = stored.toISOString().slice(0, 10);
    if (utc !== calendar) expect(readDateOnly(stored)).not.toBe(utc);
  });

  it("refuses a value that is not a date", () => {
    expect(() => readDateOnly("yesterday")).toThrow(/not a date/);
    expect(() => readDateOnly(new Date(NaN))).toThrow(/not a date/);
  });
});

describe("an ID expiry compared to the branch calendar date", () => {
  it("is still current on the day it expires", () => {
    expect(calendarBefore("2026-10-11", "2026-10-11")).toBe(false);
    expect(calendarDaysUntil("2026-10-11", "2026-10-11")).toBe(0);
    expect(calendarBefore("2026-10-10", "2026-10-11")).toBe(true);
    expect(calendarBefore("2026-10-12", "2026-10-11")).toBe(false);
  });

  it("stays current on a Toronto evening after UTC has rolled to the next day", () => {
    const at = new Date("2026-10-11T23:30:00-04:00");
    const on = businessDate(at, "America/Toronto");
    expect(on).toBe("2026-10-11");
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-12");
    expect(calendarBefore("2026-10-11", on)).toBe(false);
    expect(calendarBefore("2026-10-10", on)).toBe(true);
  });

  it("is still current just after midnight in Jerusalem on the expiry date", () => {
    const at = new Date("2026-10-12T00:30:00+03:00");
    const on = businessDate(at, "Asia/Jerusalem");
    expect(on).toBe("2026-10-12");
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-11");
    expect(calendarBefore("2026-10-12", on)).toBe(false);
    expect(calendarBefore("2026-10-11", on)).toBe(true);
  });

  it("reads a stored DATE from its calendar fields, not the UTC shift", () => {
    const stored = new Date(2026, 9, 11);
    expect(readDateOnly(stored)).toBe("2026-10-11");
    expect(calendarBefore(stored, "2026-10-11")).toBe(false);
    const utc = stored.toISOString().slice(0, 10);
    if (utc !== "2026-10-11") expect(readDateOnly(stored)).not.toBe(utc);
  });

  it("refuses a value that is not a calendar date", () => {
    expect(() => calendarBefore("yesterday", "2026-10-11")).toThrow(/not a date/);
    expect(() => calendarDaysUntil("", "2026-10-11")).toThrow(/not a date/);
  });
});

describe("signOffWindow", () => {
  it("is 23 hours across Toronto's spring forward", () => {
    const from = zonedMidnight("2026-03-08", "America/Toronto");
    const to = zonedMidnight("2026-03-09", "America/Toronto");
    expect(to.getTime() - from.getTime()).toBe(23 * 60 * 60 * 1000);
    expect(businessDate(from, "America/Toronto")).toBe("2026-03-08");
  });

  it("is 25 hours across Toronto's fall back", () => {
    const from = zonedMidnight("2026-11-01", "America/Toronto");
    const to = zonedMidnight("2026-11-02", "America/Toronto");
    expect(to.getTime() - from.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("keeps a deal posted just after midnight on the session that is still open", () => {
    const now = new Date("2026-10-12T00:30:00+03:00");
    const window = signOffWindow({
      businessDate: "2026-10-11",
      timeZone: "Asia/Jerusalem",
      closedAt: null,
      now,
    });
    expect(new Date(window.from).getTime()).toBe(zonedMidnight("2026-10-11", "Asia/Jerusalem").getTime());
    /* One millisecond past now, so a deal posted at this instant is inside
       `posted_at < to`. A flat extra day (now + 24h, or the next midnight
       + 24h) would also be greater than now, and would be the wrong end. */
    expect(new Date(window.to).getTime()).toBe(now.getTime() + 1);
    const deal = now.getTime();
    expect(deal).toBeGreaterThanOrEqual(new Date(window.from).getTime());
    expect(deal).toBeLessThan(new Date(window.to).getTime());
  });

  it("ends at the close when the session was closed after midnight", () => {
    const closedAt = new Date("2026-10-12T01:15:00+03:00");
    const now = new Date("2026-10-12T08:00:00+03:00");
    const window = signOffWindow({
      businessDate: "2026-10-11",
      timeZone: "Asia/Jerusalem",
      closedAt,
      now,
    });
    expect(window.to).toBe(closedAt.toISOString());
    const posted = new Date("2026-10-12T00:30:00+03:00").getTime();
    const afterClose = new Date("2026-10-12T02:00:00+03:00").getTime();
    expect(posted).toBeGreaterThanOrEqual(new Date(window.from).getTime());
    expect(posted).toBeLessThan(new Date(window.to).getTime());
    expect(afterClose).toBeGreaterThanOrEqual(new Date(window.to).getTime());
    expect(window.to).not.toBe(now.toISOString());
    expect(new Date(window.to).getTime()).not.toBe(
      zonedMidnight("2026-10-12", "Asia/Jerusalem").getTime(),
    );
  });

  it("is not a flat 24 hours across Jerusalem's daylight-saving nights", () => {
    const spring = signOffWindow({
      businessDate: "2026-03-27",
      timeZone: "Asia/Jerusalem",
      closedAt: null,
      now: new Date("2026-03-27T12:00:00+03:00"),
    });
    expect(new Date(spring.to).getTime() - new Date(spring.from).getTime()).toBe(23 * 60 * 60 * 1000);

    const fall = signOffWindow({
      businessDate: "2026-10-25",
      timeZone: "Asia/Jerusalem",
      closedAt: null,
      now: new Date("2026-10-25T12:00:00+02:00"),
    });
    expect(new Date(fall.to).getTime() - new Date(fall.from).getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("starts a session opened just after midnight on that new business date", () => {
    const now = new Date("2026-10-12T00:30:00+03:00");
    const date = businessDate(now, "Asia/Jerusalem");
    const window = signOffWindow({
      businessDate: date,
      timeZone: "Asia/Jerusalem",
      closedAt: null,
      now,
    });
    expect(window.from).toBe(zonedMidnight("2026-10-12", "Asia/Jerusalem").toISOString());
    expect(new Date(window.to).getTime()).toBe(zonedMidnight("2026-10-13", "Asia/Jerusalem").getTime());
    expect(now.getTime()).toBeGreaterThanOrEqual(new Date(window.from).getTime());
    expect(now.getTime()).toBeLessThan(new Date(window.to).getTime());
  });
});

describe("assertBranchTimeZone", () => {
  it("accepts a real zone and refuses a blank or a zone Intl cannot read", () => {
    expect(assertBranchTimeZone("  America/Toronto  ")).toBe("America/Toronto");
    expect(() => assertBranchTimeZone("")).toThrow(BranchTimeZoneUnset);
    expect(() => assertBranchTimeZone("   ")).toThrow(BranchTimeZoneUnset);
    expect(() => assertBranchTimeZone(null)).toThrow(BranchTimeZoneUnset);
    let refused = false;
    try {
      assertBranchTimeZone("Not/AZone");
    } catch (error) {
      refused = true;
      expect(error).toBeInstanceOf(BranchTimeZoneUnset);
      expect((error as BranchTimeZoneUnset).code).toBe("BRANCH_TIMEZONE_UNSET");
    }
    expect(refused).toBe(true);
  });
});
