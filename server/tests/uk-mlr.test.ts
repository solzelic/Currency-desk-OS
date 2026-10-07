/* The United Kingdom line, without a database.

   £12,000 or more is an occasional transaction. More than £800 is a
   transfer of funds. A desk number tightens a line only when it is
   strictly below that line, and a higher number does not lift the
   transfer. The published v1 pack is not this file's subject. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { packForCountry } from "../src/ledger/jurisdiction.js";
import { derive, JURISDICTION } from "../src/onboarding/flow.js";
import { ukAmountHits, ukOperatingLine } from "../src/ledger/uk-mlr.js";

const gbp = (value: string) => new Decimal(value);

describe("pack-gb-v2 identification lines", () => {
  it("follows the statute when the desk has not chosen a number", () => {
    const fx = ukOperatingLine("fx", gbp("12000"), "gte", null);
    const transfer = ukOperatingLine("remittance", gbp("800"), "gt", null);
    expect(ukAmountHits(gbp("11999.99"), fx)).toBe(false);
    expect(ukAmountHits(gbp("12000.00"), fx)).toBe(true);
    expect(ukAmountHits(gbp("800.00"), transfer)).toBe(false);
    expect(ukAmountHits(gbp("800.01"), transfer)).toBe(true);
  });

  it("tightens only the lines the desk number is strictly below", () => {
    const desk = gbp("1000");
    const fx = ukOperatingLine("fx", gbp("12000"), "gte", desk);
    const transfer = ukOperatingLine("remittance", gbp("800"), "gt", desk);
    expect(fx).toMatchObject({ comparator: "gte" });
    expect(fx.amount.toFixed(2)).toBe("1000.00");
    expect(ukAmountHits(gbp("1000.00"), fx)).toBe(true);
    expect(ukAmountHits(gbp("999.99"), fx)).toBe(false);
    /* 1,000 is not below 800, so the transfer stays "more than £800". */
    expect(transfer.comparator).toBe("gt");
    expect(transfer.amount.toFixed(2)).toBe("800.00");
    expect(ukAmountHits(gbp("800.00"), transfer)).toBe(false);
    expect(ukAmountHits(gbp("800.01"), transfer)).toBe(true);
  });

  it("lets a number below £800 tighten the transfer, at or above", () => {
    const transfer = ukOperatingLine("eft", gbp("800"), "gt", gbp("500"));
    expect(transfer.comparator).toBe("gte");
    expect(ukAmountHits(gbp("500.00"), transfer)).toBe(true);
    expect(ukAmountHits(gbp("499.99"), transfer)).toBe(false);
  });

  it("does not let a looser exchange number lift the transfer", () => {
    const fx = ukOperatingLine("virtual_currency", gbp("12000"), "gte", gbp("20000"));
    const transfer = ukOperatingLine("remittance", gbp("800"), "gt", gbp("20000"));
    expect(fx.amount.toFixed(2)).toBe("20000.00");
    expect(ukAmountHits(gbp("19999.99"), fx)).toBe(false);
    expect(ukAmountHits(gbp("20000.00"), fx)).toBe(true);
    expect(transfer.amount.toFixed(2)).toBe("800.00");
    expect(transfer.comparator).toBe("gt");
  });
});

describe("a new United Kingdom desk", () => {
  it("opens on pack-gb-v2 and does not seed a £10,000 cash report", () => {
    expect(packForCountry("UK")?.packId).toBe("pack-gb-v2");
    expect(JURISDICTION.GB.reportThreshold).toBeNull();
    expect(JURISDICTION.GB.idSeed).toBe(12000);
    expect(JURISDICTION.GB.noCashReport).toBe(true);
    expect(JURISDICTION.GB.report).toBe("Suspicious Activity Report");
    expect(derive({ country: "GB" }).reportThreshold).toBeNull();
    /* Canada is unchanged. Its reporting figure is still 10,000. */
    expect(JURISDICTION.CA.reportThreshold).toBe(10000);
  });

  it("does not edit pack-gb-v1", () => {
    const sql = readFileSync(
      new URL("../src/db/migrations/035_pack_gb_v2.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/pack-gb-v2/);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(sql).not.toMatch(/UPDATE\s+legal_entities/i);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_reports/i);
    expect(sql).not.toMatch(/rpt-gb-mlr/);
    const runner = readFileSync(
      new URL("../src/db/migrations.ts", import.meta.url),
      "utf8",
    );
    expect(runner).toMatch(/035_pack_gb_v2/);
  });
});
