/* The country map and the new report fields, without a database.

   An unknown country used to be handed the Canada pack. These checks
   are the ones that do not need Postgres to say so. The numbers the
   seeded packs actually hold are in pack-rules.postgres.test.ts. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  packForCountry,
  RULES_UNAVAILABLE_NOTICE,
} from "../src/ledger/jurisdiction.js";
import {
  idLineAmount,
  reportRuleFields,
} from "../src/ledger/reporting.js";
import { typedIdentificationLine } from "../src/onboarding/provision.js";

describe("which country gets a pack", () => {
  it("gives the countries that already have one the pack they had", () => {
    expect(packForCountry("CA")).toEqual({
      packId: "pack-ca-v1",
      version: 1,
      homeCurrency: "CAD",
    });
    expect(packForCountry("Canada")?.packId).toBe("pack-ca-v1");
    expect(packForCountry("United States")?.packId).toBe("pack-us-v1");
    expect(packForCountry("UK")?.packId).toBe("pack-gb-v1");
    expect(packForCountry("United Kingdom")?.homeCurrency).toBe("GBP");
    expect(packForCountry("Eurozone")?.packId).toBe("pack-eu-v1");
    expect(packForCountry("Australia")?.packId).toBe("pack-au-v1");
    expect(packForCountry("UAE")?.packId).toBe("pack-ae-v1");
  });

  it("gives an unknown country no pack, and not Canada's", () => {
    for (const country of ["", "XX", "Somewhere else", "India", "ZZ", null, undefined]) {
      expect(packForCountry(country), String(country)).toBeNull();
    }
    expect(packForCountry("Somewhere else")?.packId).not.toBe("pack-ca-v1");
  });
});

describe("an identification amount, including zero", () => {
  it("keeps zero, which means every deal, and drops a blank", () => {
    expect(idLineAmount(0)).toBe("0.00");
    expect(idLineAmount("0")).toBe("0.00");
    expect(idLineAmount(null)).toBeNull();
    expect(idLineAmount("")).toBeNull();
    expect(idLineAmount("1500")).toBe("1500.00");
  });

  it("treats a blank or a zero on the setup screen as not typed", () => {
    /* Zero on the pack means every deal. Zero in the setup box means
       the owner left it empty. The two must not be confused. */
    expect(typedIdentificationLine("")).toBeNull();
    expect(typedIdentificationLine(0)).toBeNull();
    expect(typedIdentificationLine("0")).toBeNull();
    expect(typedIdentificationLine(3000)).toBe(3000);
  });
});

describe("what a report row can now say", () => {
  it("reads a deadline, a window, a comparator, a direction and a currency", () => {
    expect(
      reportRuleFields({
        deadline_value: 15,
        deadline_unit: "calendar_days",
        window_kind: "calendar_month",
        comparator: "gt",
        direction: "both",
        threshold_currency: "eur",
      }),
    ).toEqual({
      deadlineValue: 15,
      deadlineUnit: "calendar_days",
      windowKind: "calendar_month",
      comparator: "gt",
      direction: "both",
      thresholdCurrency: "EUR",
    });
  });

  it("leaves a deadline unstated when only half of it is present", () => {
    expect(
      reportRuleFields({
        deadline_value: 15,
        deadline_unit: null,
        window_kind: "fixed_24h",
        comparator: "gte",
        direction: "in",
        threshold_currency: "CAD",
      }),
    ).toMatchObject({ deadlineValue: null, deadlineUnit: null, comparator: "gte" });
  });
});

describe("migration 028 does not restamp history", () => {
  const sql = readFileSync(
    new URL("../src/db/migrations/028_pack_rule_fields.sql", import.meta.url),
    "utf8",
  );

  it("does not rewrite a posted deal or a seeded threshold", () => {
    expect(sql).not.toMatch(/UPDATE\s+ledger_transactions/i);
    expect(sql).not.toMatch(/UPDATE\s+jurisdiction_packs/i);
    expect(sql).toMatch(/jurisdiction_id_thresholds/);
  });

  it("uses the sentence the desk shows when a country has no pack", () => {
    expect(RULES_UNAVAILABLE_NOTICE).toBe(
      "Rules for your country are not available yet",
    );
  });
});
