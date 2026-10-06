/* The new columns, against the packs that already exist.

   Seeded thresholds stay the numbers migration 011 stored. The new
   fields are filled in so that a report which aggregated over 24 hours
   still says so, and one which did not still does not. A blank
   identification answer at setup is filled from the pack's foreign
   exchange line, not from the report line. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { packForCountry, resolvePack } from "../src/ledger/jurisdiction.js";
import { idLineAmount, reportRuleFields } from "../src/ledger/reporting.js";
import { provisionDesk } from "../src/onboarding/provision.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

const text = (value: unknown) =>
  value == null ? null : String(value).trim();

postgres("pack rule fields against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("keeps every seeded pack at the threshold it already had", async () => {
    const packs = await pool.query(
      `SELECT pack_id, version, home_currency, regulator, report_name,
              report_threshold, id_threshold, report_currency,
              aggregation_hours, retention_years
         FROM jurisdiction_packs
        WHERE pack_id LIKE 'pack-%-v1'
        ORDER BY pack_id`,
    );
    const row = (id: string) =>
      packs.rows.find((item) => item.pack_id === id);
    const expectPack = (
      id: string,
      home: string,
      regulator: string,
      report: string,
      reportAt: string,
      identifyAt: string,
      retention: number,
    ) => {
      const found = row(id);
      expect(found, id).toBeTruthy();
      expect(Number(found.version)).toBe(1);
      expect(text(found.home_currency)).toBe(home);
      expect(found.regulator).toBe(regulator);
      expect(found.report_name).toBe(report);
      expect(found.report_threshold).toBe(reportAt);
      expect(found.id_threshold).toBe(identifyAt);
      expect(text(found.report_currency)).toBe(home);
      expect(Number(found.aggregation_hours)).toBe(24);
      expect(Number(found.retention_years)).toBe(retention);
    };
    expectPack("pack-ca-v1", "CAD", "FINTRAC", "LCTR", "10000.00", "3000.00", 5);
    expectPack("pack-us-v1", "USD", "FinCEN", "CTR", "10000.00", "3000.00", 5);
    expectPack("pack-gb-v1", "GBP", "HMRC", "MLR", "10000.00", "1000.00", 5);
    expectPack("pack-eu-v1", "EUR", "AMLD", "STR", "10000.00", "1000.00", 5);
    expectPack("pack-au-v1", "AUD", "AUSTRAC", "TTR", "10000.00", "1000.00", 7);
    expectPack("pack-ae-v1", "AED", "CBUAE", "STR", "55000.00", "3500.00", 5);
  });

  it("maps each seeded report onto the new fields without moving its trigger", async () => {
    const reports = await pool.query(
      `SELECT code, pack_id, kind, trigger_threshold, trigger_currency,
              aggregation_hours, deadline_value, deadline_unit, window_kind,
              comparator, direction, threshold_currency
         FROM jurisdiction_reports
        ORDER BY pack_id, code`,
    );
    const byCode = (packId: string, code: string) =>
      reports.rows.find((item) => item.pack_id === packId && item.code === code);

    const largeCash = (packId: string, code: string, amount: string, currency: string) => {
      const found = byCode(packId, code);
      expect(found, `${packId} ${code}`).toBeTruthy();
      expect(found.kind).toBe("large_cash");
      expect(found.trigger_threshold).toBe(amount);
      expect(text(found.trigger_currency)).toBe(currency);
      expect(Number(found.aggregation_hours)).toBe(24);
      expect(reportRuleFields(found)).toEqual({
        deadlineValue: null,
        deadlineUnit: null,
        windowKind: "fixed_24h",
        comparator: "gte",
        direction: "in",
        thresholdCurrency: currency,
      });
    };
    largeCash("pack-ca-v1", "LCTR", "10000.00", "CAD");
    largeCash("pack-us-v1", "CTR", "10000.00", "USD");
    largeCash("pack-au-v1", "TTR", "10000.00", "AUD");

    const wire = byCode("pack-ca-v1", "EFTR");
    expect(wire.trigger_threshold).toBe("10000.00");
    expect(Number(wire.aggregation_hours)).toBe(24);
    expect(reportRuleFields(wire)).toMatchObject({
      windowKind: "fixed_24h",
      comparator: "gte",
      direction: "both",
      thresholdCurrency: "CAD",
      deadlineValue: null,
    });

    for (const [packId, code] of [
      ["pack-ca-v1", "STR"],
      ["pack-us-v1", "SAR"],
      ["pack-gb-v1", "MLR"],
      ["pack-eu-v1", "STR"],
      ["pack-au-v1", "SMR"],
      ["pack-ae-v1", "STR"],
    ] as const) {
      const found = byCode(packId, code);
      expect(found.trigger_threshold, `${packId} ${code}`).toBeNull();
      expect(found.aggregation_hours).toBeNull();
      expect(reportRuleFields(found)).toEqual({
        deadlineValue: null,
        deadlineUnit: null,
        windowKind: "none",
        comparator: "gte",
        direction: null,
        thresholdCurrency: null,
      });
    }
  });

  it("copies each pack's identification line onto every deal kind", async () => {
    const lines = await pool.query(
      `SELECT t.pack_id, t.deal_kind, t.threshold, t.currency, p.id_threshold
         FROM jurisdiction_id_thresholds t
         JOIN jurisdiction_packs p ON p.pack_id = t.pack_id
        WHERE t.pack_id LIKE 'pack-%-v1'
        ORDER BY t.pack_id, t.deal_kind`,
    );
    const kinds = ["eft", "fx", "remittance", "virtual_currency"];
    const packs = [...new Set(lines.rows.map((row) => row.pack_id))].sort();
    expect(packs).toEqual([
      "pack-ae-v1",
      "pack-au-v1",
      "pack-ca-v1",
      "pack-eu-v1",
      "pack-gb-v1",
      "pack-us-v1",
    ]);
    for (const packId of packs) {
      const mine = lines.rows.filter((row) => row.pack_id === packId);
      expect(mine.map((row) => row.deal_kind)).toEqual(kinds);
      for (const row of mine) {
        expect(row.threshold).toBe(row.id_threshold);
        expect(Number(row.threshold)).toBeGreaterThan(0);
      }
    }
    const canadaFx = lines.rows.find(
      (row) => row.pack_id === "pack-ca-v1" && row.deal_kind === "fx",
    );
    expect(canadaFx.threshold).toBe("3000.00");
    expect(text(canadaFx.currency)).toBe("CAD");
  });

  it("round-trips a deadline, a calendar month, a strict comparator and a zero line", async () => {
    await pool.query(
      `INSERT INTO jurisdiction_packs
         (pack_id, jurisdiction, version, name, home_currency, regulator,
          report_name, report_threshold, id_threshold, report_currency)
       VALUES ('pack-probe-v1','QP',1,'Probe','EUR','PROBE','STR',1000,1000,'EUR')
       ON CONFLICT (pack_id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO jurisdiction_reports
         (report_id, pack_id, code, name, kind, trigger_threshold,
          trigger_currency, aggregation_hours, deadline_value, deadline_unit,
          window_kind, comparator, direction, threshold_currency)
       VALUES ('rpt-probe','pack-probe-v1','PROBE','Probe report','large_cash',
               1000,'EUR',NULL,15,'calendar_days','calendar_month','gt','out','EUR')
       ON CONFLICT (report_id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO jurisdiction_id_thresholds (pack_id, deal_kind, threshold, currency)
       VALUES ('pack-probe-v1','fx',0,'EUR'),
              ('pack-probe-v1','remittance',NULL,NULL),
              ('pack-probe-v1','eft',500,'EUR'),
              ('pack-probe-v1','virtual_currency',0,'EUR')
       ON CONFLICT (pack_id, deal_kind) DO NOTHING`,
    );

    const report = (
      await pool.query(
        `SELECT deadline_value, deadline_unit, window_kind, comparator,
                direction, threshold_currency, trigger_threshold
           FROM jurisdiction_reports WHERE report_id='rpt-probe'`,
      )
    ).rows[0];
    expect(reportRuleFields(report)).toEqual({
      deadlineValue: 15,
      deadlineUnit: "calendar_days",
      windowKind: "calendar_month",
      comparator: "gt",
      direction: "out",
      thresholdCurrency: "EUR",
    });
    expect(report.trigger_threshold).toBe("1000.00");

    const lines = await pool.query(
      `SELECT deal_kind, threshold, currency
         FROM jurisdiction_id_thresholds
        WHERE pack_id='pack-probe-v1'
        ORDER BY deal_kind`,
    );
    const line = (kind: string) =>
      lines.rows.find((row) => row.deal_kind === kind);
    expect(idLineAmount(line("fx").threshold)).toBe("0.00");
    expect(text(line("fx").currency)).toBe("EUR");
    expect(idLineAmount(line("remittance").threshold)).toBeNull();
    expect(line("remittance").currency).toBeNull();
    expect(idLineAmount(line("eft").threshold)).toBe("500.00");
    expect(idLineAmount(line("virtual_currency").threshold)).toBe("0.00");

    /* Taken back out. `jurisdiction` plus version is unique, and another
       suite in this same database inserts its own pack under ZZ. Leaving
       a probe row behind would make that insert fail. */
    await pool.query(
      "DELETE FROM jurisdiction_id_thresholds WHERE pack_id='pack-probe-v1'",
    );
    await pool.query(
      "DELETE FROM jurisdiction_reports WHERE pack_id='pack-probe-v1'",
    );
    await pool.query(
      "DELETE FROM jurisdiction_packs WHERE pack_id='pack-probe-v1'",
    );
  });

  const clearDesk = async (slug: string) => {
    const entity = `le-${slug}`;
    await pool.query(
      "DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE legal_entity_id=$1)",
      [entity],
    );
    for (const table of ["staff_users", "workspaces", "rate_boards", "branches"]) {
      await pool.query(`DELETE FROM ${table} WHERE legal_entity_id=$1`, [entity]);
    }
    await pool.query("DELETE FROM legal_entities WHERE id=$1", [entity]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [`tnt-${slug}`]);
  };

  it("fills a blank identification answer from the pack, not from the report line", async () => {
    const slug = "pack-blank-id";
    await clearDesk(slug);

    const setup: Record<string, unknown> = {
      country: "CA",
      regulator: "FINTRAC",
      homeCurrency: "CAD",
      reportThreshold: 10000,
    };
    await provisionDesk(
      handle.db,
      {
        businessName: "Blank ID Desk",
        legalName: "Blank ID Desk Inc.",
        ownerName: "Owner",
        email: "blank-id@example.test",
        slug,
        plan: "pro",
        setup,
        msbNumber: null,
        regulator: "FINTRAC",
        team: [],
      },
      "hash",
      "test",
    );
    /* Canada reports at 10,000 and identifies a foreign exchange at 3,000.
       The blank box must become the second of those. */
    expect(setup.idThreshold).toBe(3000);
    expect(setup.idThreshold).not.toBe(10000);
    const stored = (
      await pool.query("SELECT setup FROM tenants WHERE id=$1", [`tnt-${slug}`])
    ).rows[0];
    expect(stored.setup.idThreshold).toBe(3000);
    const entity = (
      await pool.query("SELECT id_threshold, jurisdiction_pack_id FROM legal_entities WHERE id=$1", [
        `le-${slug}`,
      ])
    ).rows[0];
    /* 3,000 is the pack's own line, so the desk follows the pack rather
       than pinning a copy of it. */
    expect(entity.id_threshold).toBeNull();
    expect(entity.jurisdiction_pack_id).toBe("pack-ca-v1");
  });

  it("opens a desk for an unknown country without installing Canada's pack", async () => {
    const slug = "pack-unknown-country";
    await clearDesk(slug);

    expect(packForCountry("XX")).toBeNull();
    const setup: Record<string, unknown> = {
      country: "XX",
      homeCurrency: "USD",
      reportThreshold: 10000,
    };
    const created = await provisionDesk(
      handle.db,
      {
        businessName: "Elsewhere Desk",
        legalName: "Elsewhere Desk Inc.",
        ownerName: "Owner",
        email: "elsewhere@example.test",
        slug,
        plan: "pro",
        setup,
        msbNumber: null,
        regulator: "your regulator",
        team: [],
      },
      "hash",
      "test",
    );
    expect(created.tenantId).toBe(`tnt-${slug}`);
    expect(setup.rulesUnavailable).toBe(true);
    expect(setup.idThreshold ?? null).toBeNull();
    const entity = (
      await pool.query(
        `SELECT jurisdiction_pack_id, home_currency, id_threshold
           FROM legal_entities WHERE id=$1`,
        [`le-${slug}`],
      )
    ).rows[0];
    expect(entity.jurisdiction_pack_id).toBeNull();
    expect(text(entity.home_currency)).toBe("USD");
    expect(entity.id_threshold).toBeNull();
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, `le-${slug}`);
      expect(pack.available).toBe(false);
      expect(pack.packId).not.toBe("pack-ca-v1");
      expect(pack.regulator).not.toBe("FINTRAC");
      expect(pack.reportName).not.toBe("LCTR");
      expect(pack.idThreshold).not.toBe("3000.00");
      expect(pack.homeCurrency).toBe("USD");
    } finally {
      client.release();
    }
  });

  it("leaves a posted deal pointing at the pack it was posted under", async () => {
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
          workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
          input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
          source_of_funds, posted_at, deal_kind, received_instrument,
          disbursed_instrument, jurisdiction_pack_id, jurisdiction_pack_version,
          home_currency)
       VALUES ('tx-pack-snap','ref-pack-snap','tnt-snap','le-snap','br-snap',
               'ws-snap','till-snap','cust-snap','actor-snap','USD','CAD',
               100,130,1.3,0,0,'travel','salary',now(),'exchange','cash','cash',
               'pack-ca-v1',1,'CAD')
       ON CONFLICT (transaction_id) DO NOTHING`,
    );
    const row = (
      await pool.query(
        `SELECT jurisdiction_pack_id, jurisdiction_pack_version, home_currency
           FROM ledger_transactions WHERE transaction_id='tx-pack-snap'`,
      )
    ).rows[0];
    expect(row.jurisdiction_pack_id).toBe("pack-ca-v1");
    expect(Number(row.jurisdiction_pack_version)).toBe(1);
    expect(text(row.home_currency)).toBe("CAD");
  });
});
