/* The country map and the new report fields, without a database.

   An unknown country used to be handed the Canada pack. These checks
   are the ones that do not need Postgres to say so. The numbers the
   seeded packs actually hold are in pack-rules.postgres.test.ts. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  packForCountry,
  packIdThreshold,
  RULES_UNAVAILABLE_NOTICE,
} from "../src/ledger/jurisdiction.js";
import {
  idLineAmount,
  reportRuleFields,
} from "../src/ledger/reporting.js";
import { specFromAnswers, typedIdentificationLine } from "../src/onboarding/provision.js";
import { resolve } from "../src/onboarding/flow.js";

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
      windowDays: null,
      comparator: "gt",
      direction: "both",
      thresholdCurrency: "EUR",
      cashOnly: false,
    });
  });

  it("reads the deadline and window shapes the next packs need", () => {
    expect(
      reportRuleFields({
        deadline_unit: "immediately",
        window_kind: "banking_day",
        comparator: "gte",
      }),
    ).toMatchObject({
      deadlineValue: null,
      deadlineUnit: "immediately",
      windowKind: "banking_day",
      windowDays: null,
    });
    expect(
      reportRuleFields({
        deadline_value: 24,
        deadline_unit: "hours",
        window_kind: "rolling_days",
        window_days: 30,
        comparator: "gt",
        cash_only: true,
      }),
    ).toMatchObject({
      deadlineValue: 24,
      deadlineUnit: "hours",
      windowKind: "rolling_days",
      windowDays: 30,
      comparator: "gt",
      cashOnly: true,
    });
    expect(
      reportRuleFields({
        deadline_value: 15,
        deadline_unit: "monthly_day",
        window_kind: "none",
      }).deadlineUnit,
    ).toBe("monthly_day");
    expect(
      reportRuleFields({
        deadline_unit: "before_execution",
        window_kind: "none",
      }).deadlineUnit,
    ).toBe("before_execution");
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
      "Rules for your country are not available yet, so deals are paused. We will let you know when they are ready.",
    );
  });

  it("copies only a positive identification line and refuses to mislabel a window", () => {
    expect(sql).toMatch(/WHERE p\.id_threshold > 0/);
    expect(sql).toMatch(/aggregation_hours <> 24/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/RAISE NOTICE/);
    expect(sql).toMatch(/pack-ca-v1/);
    expect(sql).toMatch(/'rolling_days'/);
    expect(sql).toMatch(/'monthly_day'/);
    expect(sql).toMatch(/'before_execution'/);
  });

  it("backfills only a CAD or blank home currency, and the runner wraps the file in a transaction", () => {
    const start = sql.indexOf("-- pack-backfill:start");
    const end = sql.indexOf("-- pack-backfill:end");
    const backfill = sql.slice(start, end);
    expect(backfill).toMatch(/upper\(btrim\(home_currency::text\)\) = 'CAD'/);
    expect(backfill).toMatch(/home_currency = 'CAD'/);
    expect(backfill).toMatch(/pack-ca-v1/);
    expect(backfill).not.toMatch(/pack-gb-v1|pack-au-v1|pack-ae-v1|pack-eu-v1/);
    const runner = readFileSync(
      new URL("../src/db/migrations.ts", import.meta.url),
      "utf8",
    );
    const begin = runner.indexOf('await client.query("BEGIN")');
    const apply = runner.indexOf("await client.query(sql)");
    const commit = runner.indexOf('await client.query("COMMIT")');
    const rollback = runner.indexOf('await client.query("ROLLBACK")');
    expect(begin).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(apply);
    expect(rollback).toBeGreaterThan(commit);
  });
});

describe("an identification line, tagged", () => {
  const boom = (code: string) => {
    const error = new Error("db") as Error & { code?: string };
    error.code = code;
    return error;
  };

  it("treats only a missing table as unavailable", async () => {
    const missing = {
      execute: async () => {
        throw boom("42P01");
      },
    };
    await expect(packIdThreshold(missing, "pack-ca-v1", "fx")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("lets any other database error through", async () => {
    const broken = {
      execute: async () => {
        throw boom("42703");
      },
    };
    await expect(packIdThreshold(broken, "pack-ca-v1", "fx")).rejects.toThrow(/db/);
  });

  it("returns a Decimal for a positive line and does not treat zero as a float", async () => {
    const db = {
      execute: async () => [{ threshold: "1000.10" }],
    };
    const line = await packIdThreshold(db, "pack-ca-v1", "fx");
    expect(line.status).toBe("amount");
    if (line.status === "amount") expect(line.amount.toFixed(2)).toBe("1000.10");
  });

  it("reads zero as every deal and null as not applicable", async () => {
    await expect(
      packIdThreshold({ execute: async () => [{ threshold: "0" }] }, "p", "fx"),
    ).resolves.toEqual({ status: "every_deal" });
    await expect(
      packIdThreshold({ execute: async () => [{ threshold: null }] }, "p", "fx"),
    ).resolves.toEqual({ status: "not_applicable" });
  });
});

describe("a country the list does not know", () => {
  it("does not invent Canada, FINTRAC, or CAD", () => {
    for (const country of ["", "RS", "Somewhere else"]) {
      const spec = specFromAnswers(
        resolve(
          { operatingName: "Shop", bizName: "Shop Inc.", ownerName: "A", ownerEmail: "a@example.test", country },
          {},
        ),
        {},
      );
      const setup = spec.setup as Record<string, unknown>;
      expect(spec.regulator, country).not.toBe("FINTRAC");
      expect(spec.regulator, country).toBe("");
      expect(setup.homeCurrency, country).not.toBe("CAD");
      expect(setup.homeCurrency, country).toBe("");
      expect(setup.reportName, country).toBe("");
      expect(setup.country, country).toBe(country);
    }
  });

  it("keeps a home currency the setup actually named", () => {
    const spec = specFromAnswers(
      resolve(
        {
          operatingName: "Shop",
          country: "RS",
          homeCurrency: "RSD",
          regulator: "APR",
        },
        {},
      ),
      {},
    );
    const setup = spec.setup as Record<string, unknown>;
    expect(setup.homeCurrency).toBe("RSD");
    expect(spec.regulator).toBe("APR");
  });
});
