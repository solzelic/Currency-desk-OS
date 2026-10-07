/* India arithmetic, without a database. The amounts the pack row holds
   are checked in india-pack.postgres.test.ts. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  INDIA_PURPOSE_MESSAGE,
  INDIA_SALE_CASH_MESSAGE,
  indiaCashRupees,
  indiaCtrFindings,
  indiaIdentificationRequired,
  indiaPurposeRequired,
  indiaSaleCashBlocked,
  kolkataMonthKey,
  residentCashPayoutWithinLimit,
} from "../src/ledger/india-pack.js";
import { assertIndiaPurpose } from "../src/ledger/service.js";
import { derive } from "../src/onboarding/flow.js";

const rupees = (value: string) => new Decimal(value);
const at = (iso: string) => new Date(iso);

describe("India on the signup list", () => {
  it("names RBI and FIU-IND, rupees, and a cash report of 10 lakh", () => {
    expect(derive({ country: "IN" })).toMatchObject({
      regulator: "RBI / FIU-IND",
      homeCurrency: "INR",
      reportThreshold: 1000000,
      reportName: "Currency Transaction Report",
    });
  });
});

describe("a cash transaction report, more than 10 lakh", () => {
  const customer = "cust-1";

  it("does not report exactly 10 lakh, and does report one paisa over", () => {
    expect(indiaCtrFindings([
      { amount: rupees("1000000.00"), at: at("2026-10-15T12:00:00Z"), customerId: customer },
    ])).toEqual([]);
    const over = indiaCtrFindings([
      { amount: rupees("1000000.01"), at: at("2026-10-15T12:00:00Z"), customerId: customer },
    ]);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ limb: "single", month: "2026-10" });
    expect(over[0]!.amount.toFixed(2)).toBe("1000000.01");
  });

  it("needs two deals below the line before a month is a series", () => {
    const october = at("2026-10-02T04:00:00Z");
    expect(indiaCtrFindings([
      { amount: rupees("500000"), at: october, customerId: customer },
      { amount: rupees("500000"), at: october, customerId: customer },
    ])).toEqual([]);
    const series = indiaCtrFindings([
      { amount: rupees("500000"), at: october, customerId: customer },
      { amount: rupees("500000.01"), at: october, customerId: customer },
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]!.limb).toBe("series");
    expect(series[0]!.amount.toFixed(2)).toBe("1000000.01");
    expect(indiaCtrFindings([
      { amount: rupees("600000"), at: october, customerId: customer },
    ])).toEqual([]);
  });

  it("keeps a deal already over 10 lakh out of the series", () => {
    const october = at("2026-10-02T04:00:00Z");
    const found = indiaCtrFindings([
      { amount: rupees("1000000.01"), at: october, customerId: customer },
      { amount: rupees("600000"), at: october, customerId: customer },
    ]);
    expect(found.map((row) => row.limb)).toEqual(["single"]);
  });

  it("does not add two customers, two months, or a deal with no customer", () => {
    const early = at("2026-10-02T04:00:00Z");
    const later = at("2026-11-02T04:00:00Z");
    expect(indiaCtrFindings([
      { amount: rupees("600000"), at: early, customerId: "a" },
      { amount: rupees("600000"), at: early, customerId: "b" },
      { amount: rupees("600000"), at: early, customerId: "a" },
      { amount: rupees("600000"), at: later, customerId: "a" },
      { amount: rupees("600000"), at: early, customerId: null },
      { amount: rupees("600000"), at: early, customerId: "  " },
    ])).toHaveLength(1);
  });

  it("splits the month on Asia/Kolkata midnight, not UTC midnight", () => {
    /* 18:29 UTC on 30 Sep is 23:59 in Kolkata. 18:30 UTC is 00:00 on 1 Oct. */
    expect(kolkataMonthKey(at("2026-09-30T18:29:00Z"))).toBe("2026-09");
    expect(kolkataMonthKey(at("2026-09-30T18:30:00Z"))).toBe("2026-10");
    const found = indiaCtrFindings([
      { amount: rupees("600000"), at: at("2026-09-30T18:29:00Z"), customerId: customer },
      { amount: rupees("600000"), at: at("2026-09-30T18:30:00Z"), customerId: customer },
    ]);
    expect(found).toEqual([]);
  });

  it("values one rupee leg and leaves a cross with no rupee leg unvalued", () => {
    expect(indiaCashRupees({
      from: "INR",
      to: "USD",
      inputAmount: rupees("40000"),
      outputAmount: rupees("450"),
    })?.toFixed(2)).toBe("40000.00");
    expect(indiaCashRupees({
      from: "USD",
      to: "INR",
      inputAmount: rupees("450"),
      outputAmount: rupees("40000"),
    })?.toFixed(2)).toBe("40000.00");
    expect(indiaCashRupees({
      from: "USD",
      to: "EUR",
      inputAmount: rupees("100"),
      outputAmount: rupees("90"),
    })).toBeNull();
  });
});

describe("walk-in due diligence and a cash sale", () => {
  it("identifies a walk-in at 50,000 and every remittance", () => {
    expect(indiaIdentificationRequired(rupees("49999.99"), "exchange", null)).toBe(false);
    expect(indiaIdentificationRequired(rupees("50000"), "exchange", null)).toBe(true);
    expect(indiaIdentificationRequired(rupees("1"), "remittance_send", null)).toBe(true);
    expect(indiaIdentificationRequired(rupees("1"), "eft", null)).toBe(true);
    expect(indiaIdentificationRequired(rupees("49999.99"), "virtual_currency", null)).toBe(false);
    expect(indiaIdentificationRequired(rupees("50000"), "virtual_currency", null)).toBe(true);
  });

  it("lets a desk tighten the walk-in line and not loosen a remittance", () => {
    expect(indiaIdentificationRequired(rupees("10000"), "exchange", rupees("10000"))).toBe(true);
    expect(indiaIdentificationRequired(rupees("9999.99"), "exchange", rupees("10000"))).toBe(false);
    expect(indiaIdentificationRequired(rupees("1"), "remittance", rupees("90000"))).toBe(true);
    expect(indiaIdentificationRequired(rupees("40000"), "exchange", rupees("90000"))).toBe(false);
  });

  it("asks for purpose on the due-diligence line, including a verified remittance", () => {
    expect(indiaPurposeRequired(rupees("49999.99"), "exchange")).toBe(false);
    expect(indiaPurposeRequired(rupees("50000"), "exchange")).toBe(true);
    expect(indiaPurposeRequired(rupees("1"), "remittance_receive")).toBe(true);
    const pack = { packId: "pack-in-v1" } as never;
    expect(() => assertIndiaPurpose(pack, rupees("1"), "remittance_send", "", "")).toThrow(
      INDIA_PURPOSE_MESSAGE,
    );
    expect(() => assertIndiaPurpose(pack, rupees("1"), "remittance_send", "travel", "salary")).not.toThrow();
    expect(() => assertIndiaPurpose(pack, rupees("100"), "exchange", "", "")).not.toThrow();
    expect(() =>
      assertIndiaPurpose({ packId: "pack-ca-v1" } as never, rupees("100000"), "remittance", "", ""),
    ).not.toThrow();
  });

  it("refuses cash for a sale at 50,000 INR and not for a purchase", () => {
    const sale = (amount: string) =>
      indiaSaleCashBlocked({
        packId: "pack-in-v1",
        from: "INR",
        to: "USD",
        inputAmount: rupees(amount),
        home: "INR",
      });
    expect(sale("49999.99")).toBe(false);
    expect(sale("50000")).toBe(true);
    expect(indiaSaleCashBlocked({
      packId: "pack-in-v1",
      from: "USD",
      to: "INR",
      inputAmount: rupees("2000"),
      home: "INR",
    })).toBe(false);
    expect(indiaSaleCashBlocked({
      packId: "pack-ca-v1",
      from: "INR",
      to: "USD",
      inputAmount: rupees("80000"),
      home: "INR",
    })).toBe(false);
    expect(INDIA_SALE_CASH_MESSAGE).not.toMatch(/[—–]/);
  });

  it("knows the resident 1,000 USD payout and does not call it from posting", () => {
    expect(residentCashPayoutWithinLimit(rupees("1000"))).toBe(true);
    expect(residentCashPayoutWithinLimit(rupees("1000.01"))).toBe(false);
    const posting = readFileSync(new URL("../src/ledger/service.ts", import.meta.url), "utf8");
    expect(posting).not.toMatch(/residentCashPayoutWithinLimit/);
  });
});
