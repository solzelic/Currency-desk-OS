/* The reporting line and the sheet of paper.

   Canada counts a deal of 10,000.00. A comparison that uses `>` leaves
   that deal off the sheet and keeps 10,000.01, which is a different
   rule. 9,999.99 is under the line either way. These cases fail when
   the default comparison stops being `>=`. */
import { describe, expect, it } from "vitest";
import {
  formatBranchTime,
  formatCalendarDate,
  meetsReportingLine,
  renderSignoffPdf,
  signoffLines,
  type CloseOfDaySnapshot,
} from "../src/ledger/close-of-day.js";

describe("meetsReportingLine", () => {
  it("counts 10,000.00 and leaves 9,999.99 off when the line is inclusive", () => {
    expect(meetsReportingLine("9999.99", "10000.00")).toBe(false);
    expect(meetsReportingLine("10000.00", "10000.00")).toBe(true);
    expect(meetsReportingLine("10000.01", "10000.00")).toBe(true);
  });

  it("leaves 10,000.00 off when the pack's comparator is greater-than", () => {
    expect(meetsReportingLine("9999.99", "10000.00", "gt")).toBe(false);
    expect(meetsReportingLine("10000.00", "10000.00", "gt")).toBe(false);
    expect(meetsReportingLine("10000.01", "10000.00", "gt")).toBe(true);
  });
});

describe("the sheet's clock", () => {
  it("names 9:00 PM in Toronto when the instant is 01:00 UTC", () => {
    expect(formatBranchTime(new Date("2026-10-13T01:00:00.000Z"), "America/Toronto")).toBe("9:00 PM");
    expect(formatCalendarDate("2026-10-12")).toBe("Oct 12, 2026");
  });
});

describe("the signed PDF", () => {
  const snapshot: CloseOfDaySnapshot = {
    shopName: "York FX Canada",
    businessDate: "2026-10-12",
    timeZone: "America/Toronto",
    from: "2026-10-12T04:00:00.000Z",
    to: "2026-10-13T01:00:00.000Z",
    signedAt: "2026-10-13T01:00:00.000Z",
    signedBy: "tnt-yorkfx:j.masri",
    tillId: "till-01",
    sessionId: "session-1",
    notCounted: true,
    homeCurrency: "CAD",
    posted: 0,
    reversed: 0,
    volumeHome: "0.00",
    volumeByCurrency: [],
    feesHome: "0.00",
    realizedPnlHome: null,
    earningsHome: "0.00",
    drawerHome: null,
    drawerCurrencies: [],
    reportingLine: "10000.00",
    reportingCurrency: "CAD",
    reportingComparator: "gte",
    singleDeals: 0,
    lctrCustomers: 0,
    clientsMissingId: 0,
  };

  it("is one A4 page, with the shop, the large-cash line, and both signatures", () => {
    const lines = signoffLines(snapshot);
    expect(lines.every((line) => line.length <= 72)).toBe(true);
    const teller = lines.indexOf("Teller");
    const owner = lines.indexOf("Owner");
    expect(teller).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(teller);
    expect(lines.some((line) => line.includes("Teller") && line.includes("Owner"))).toBe(false);
    const pdf = renderSignoffPdf(snapshot).toString("latin1");
    expect(pdf.startsWith("%PDF")).toBe(true);
    expect(pdf).toContain("York FX Canada");
    expect(pdf).toContain("Oct 12, 2026, 9:00 PM");
    expect(pdf).toContain("Single deals of 10000 CAD or more");
    expect(pdf).toContain("Teller");
    expect(pdf).toContain("Owner");
    expect(pdf).toContain("/MediaBox [0 0 595 842]");
  });
});
