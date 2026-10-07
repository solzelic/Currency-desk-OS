/* The lines that do not need a database: comparators, the purpose
   decision, and the promise that migration 036 does not edit v1. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { idKindForDeal } from "../src/ledger/compliance-gate.js";
import { JURISDICTION } from "../src/onboarding/flow.js";
import {
  AE_FX_CDD_ONE_OFF,
  AE_FX_CID,
  aeAmountHits,
  aeOperatingLine,
  aePurposeDecision,
} from "../src/ledger/uae-exchange.js";

const aed = (value: string) => new Decimal(value);

describe("UAE foreign-exchange floor", () => {
  const statute = aeOperatingLine(AE_FX_CID, "gte", null);

  it("identifies at 3,500.00 and not at 3,499.99", () => {
    expect(aeAmountHits(aed("3499.99"), statute)).toBe(false);
    expect(aeAmountHits(aed("3500.00"), statute)).toBe(true);
  });

  it("lets a lower desk number tighten, and ignores one that would raise the floor", () => {
    const tighter = aeOperatingLine(AE_FX_CID, "gte", aed("1000"));
    expect(aeAmountHits(aed("999.99"), tighter)).toBe(false);
    expect(aeAmountHits(aed("1000.00"), tighter)).toBe(true);
    const ignored = aeOperatingLine(AE_FX_CID, "gte", aed("10000"));
    expect(ignored.amount.toFixed(2)).toBe("3500.00");
    expect(aeAmountHits(aed("3500.00"), ignored)).toBe(true);
    expect(aeAmountHits(aed("3499.99"), ignored)).toBe(false);
  });
});

describe("UAE purpose and source of funds", () => {
  it("requires them on one foreign exchange of 35,000 or more, and not below", () => {
    expect(AE_FX_CDD_ONE_OFF.toFixed(2)).toBe("35000.00");
    expect(aePurposeDecision("fx", null, aed("34999.99"))).toBe("allow");
    expect(aePurposeDecision("fx", null, aed("35000.00"))).toBe("cdd");
  });

  it("still honours a reporting number the desk typed", () => {
    expect(aePurposeDecision("fx", aed("10000"), aed("10000.00"))).toBe("cdd");
    expect(aePurposeDecision("fx", aed("10000"), aed("9999.99"))).toBe("allow");
  });

  it("requires them on every money transfer and every electronic transfer", () => {
    expect(aePurposeDecision("remittance", null, aed("0.01"))).toBe("cdd");
    expect(aePurposeDecision("eft", null, aed("1.00"))).toBe("cdd");
    expect(idKindForDeal("money_order")).toBe("remittance");
    expect(idKindForDeal("bill_payment")).toBe("eft");
    expect(idKindForDeal("cheque_cashing")).toBe("fx");
  });
});

describe("a new UAE desk does not invent a cash report", () => {
  it("seeds identification at 3,500 and names no reporting amount", () => {
    const ae = JURISDICTION.AE;
    if (!ae) throw new Error("The UAE row is missing from the onboarding table.");
    expect(ae.reportThreshold).toBeNull();
    expect(ae.idSeed).toBe(3500);
    expect(ae.noCashReport).toBe(true);
  });
});

describe("migration 036 does not edit the published pack", () => {
  const sql = readFileSync(
    new URL("../src/db/migrations/036_pack_ae_v2.sql", import.meta.url),
    "utf8",
  );

  it("inserts pack-ae-v2 and does not update a desk or pack-ae-v1", () => {
    expect(sql).toMatch(/pack-ae-v2/);
    expect(sql).not.toMatch(/UPDATE\s+legal_entities/i);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(sql).not.toMatch(/UPDATE\s+ledger_transactions/i);
    expect(sql).toMatch(/renumber/i);
  });

  it("does not put a cash report at 55,000 on the new pack", () => {
    expect(sql).not.toMatch(/large_cash/);
    expect(sql).toMatch(/'STR', 0, 3500/);
  });
});

describe("a cheque is not given a purpose rule", () => {
  it("the cheque service does not call the purpose gate", () => {
    const source = readFileSync(
      new URL("../src/ledger/cheques.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("requirePurposeAndSource");
  });
});
