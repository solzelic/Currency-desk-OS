/* The 2027 European Union lines, without a database.
   Amounts are Decimal. A float would not be asked to decide
   whether 999.99 is under 1,000. */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  EU_AMLR_APPLIES_FROM,
  EU_AMLR_NOTICE,
  euAmlrDuty,
  euAmlrNotice,
  type EuIdLine,
} from "../src/ledger/eu-amlr.js";
import { packForCountry } from "../src/ledger/jurisdiction.js";
import { derive, JURISDICTION } from "../src/onboarding/flow.js";

const eur = (lineId: string, dealKind: string, amount: string, diligence: EuIdLine["diligence"], cashOnly: boolean): EuIdLine => ({
  lineId,
  dealKind,
  threshold: new Decimal(amount),
  comparator: "gte",
  diligence,
  cashOnly,
});

const lines: EuIdLine[] = [
  eur("cash_identify", "any", "3000", "identify", true),
  eur("occasional_cdd", "any", "10000", "cdd", false),
  eur("transfer_cdd", "remittance", "1000", "cdd", false),
  eur("transfer_cdd", "eft", "1000", "cdd", false),
];

const duty = (
  amount: string,
  dealKind: string,
  cash: boolean,
  desk: string | null = null,
) => euAmlrDuty({
  lines,
  amountHome: new Decimal(amount),
  dealKind,
  cash,
  deskCashIdentify: desk ? new Decimal(desk) : null,
});

describe("EU AMLR 2027 lines", () => {
  it("points a new European Union desk at version 2, in euros", () => {
    expect(packForCountry("European Union")).toEqual({
      packId: "pack-eu-v2",
      version: 2,
      homeCurrency: "EUR",
    });
    expect(packForCountry("Eurozone")?.version).toBe(2);
    expect(packForCountry("Canada")?.packId).toBe("pack-ca-v2");
  });

  it("does not invent a large-cash report in the signup answers", () => {
    const eu = JURISDICTION.EU;
    expect(eu).toBeTruthy();
    expect(eu?.reportThreshold).toBeNull();
    expect(eu?.idDefault).toBe(3000);
    expect(derive({ country: "EU" }).reportThreshold).toBeNull();
    expect(derive({ country: "CA" }).reportThreshold).toBe(10000);
  });

  it("shows the disclaimer only before 10 July 2027", () => {
    expect(EU_AMLR_APPLIES_FROM).toBe("2027-07-10");
    expect(euAmlrNotice("2027-07-10", new Date("2026-10-07T12:00:00Z"))).toBe(EU_AMLR_NOTICE);
    expect(euAmlrNotice("2027-07-10", new Date("2027-07-09T23:00:00Z"))).toBe(EU_AMLR_NOTICE);
    expect(euAmlrNotice("2027-07-10", new Date("2027-07-10T00:00:00Z"))).toBeNull();
    expect(euAmlrNotice("2027-07-10", new Date("2027-07-11T00:00:00Z"))).toBeNull();
    expect(EU_AMLR_NOTICE).not.toMatch(/[—–]/);
  });

  it("identifies cash at 3,000 and does not treat that as full due diligence", () => {
    expect(duty("2999.99", "exchange", true)).toEqual({ identify: false, cdd: false, failClosed: false });
    expect(duty("3000.00", "exchange", true)).toEqual({ identify: true, cdd: false, failClosed: false });
    expect(duty("3000.00", "exchange", false)).toEqual({ identify: false, cdd: false, failClosed: false });
  });

  it("requires full due diligence at 10,000, including a transfer already over 1,000", () => {
    expect(duty("9999.99", "exchange", true).cdd).toBe(false);
    expect(duty("10000.00", "exchange", true)).toMatchObject({ identify: true, cdd: true });
    expect(duty("10000.00", "remittance_send", false)).toMatchObject({ cdd: true });
  });

  it("treats a transfer of at least 1,000 as customer due diligence", () => {
    expect(duty("999.99", "remittance_send", true).identify).toBe(false);
    expect(duty("1000.00", "remittance", true)).toMatchObject({ identify: true, cdd: true });
    expect(duty("1000.00", "eft", false)).toMatchObject({ cdd: true });
    expect(duty("1000.00", "bill_payment", true)).toMatchObject({ cdd: true });
  });

  it("does not treat a cashed cheque as the cash identification line", () => {
    expect(duty("4000.00", "cheque_cashing", true)).toEqual({ identify: false, cdd: false, failClosed: false });
    expect(duty("10000.00", "cheque_cashing", true)).toMatchObject({ identify: true, cdd: true });
  });

  it("lets the desk move only the cash identification line", () => {
    expect(duty("4000.00", "exchange", true, "5000").identify).toBe(false);
    expect(duty("5000.00", "exchange", true, "5000")).toMatchObject({ identify: true, cdd: false });
    expect(duty("1000.00", "exchange", true, "1000")).toMatchObject({ identify: true, cdd: false });
    expect(duty("1000.00", "remittance", true, "5000")).toMatchObject({ cdd: true });
    expect(duty("10000.00", "exchange", true, "15000")).toMatchObject({ cdd: true });
  });

  it("does not add two smaller deals into one obligation", () => {
    expect(duty("2000.00", "exchange", true).identify).toBe(false);
    expect(duty("2000.00", "exchange", true).identify).toBe(false);
  });

  it("fails closed when the lines cannot be read", () => {
    expect(euAmlrDuty({
      lines: null,
      amountHome: new Decimal("1"),
      dealKind: "exchange",
      cash: true,
      deskCashIdentify: null,
    }).failClosed).toBe(true);
    expect(euAmlrDuty({
      lines: [],
      amountHome: new Decimal("1"),
      dealKind: "exchange",
      cash: true,
      deskCashIdentify: null,
    }).failClosed).toBe(true);
  });
});
