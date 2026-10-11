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
  readDateOnly,
  signOffWindow,
  zonedMidnight,
} from "../src/ledger/business-date.js";

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
    expect(new Date(window.to).getTime()).toBeGreaterThan(now.getTime());
    const deal = now.getTime();
    expect(deal).toBeGreaterThanOrEqual(new Date(window.from).getTime());
    expect(deal).toBeLessThan(new Date(window.to).getTime());
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
