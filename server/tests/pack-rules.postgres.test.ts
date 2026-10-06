/* The new columns, against the packs that already exist.

   Seeded thresholds stay the numbers migration 011 stored. The new
   fields are filled in so that a report which aggregated over 24 hours
   still says so, and one which did not still does not. A blank
   identification answer at setup is filled from the pack's foreign
   exchange line, not from the report line. */
import { readFileSync } from "node:fs";
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
        windowDays: null,
        comparator: "gte",
        direction: "in",
        thresholdCurrency: currency,
        cashOnly: false,
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
        windowDays: null,
        comparator: "gte",
        direction: null,
        thresholdCurrency: null,
        cashOnly: false,
      });
    }
  });

  it("copies each pack's identification line onto every deal kind", async () => {
    const lines = await pool.query(
      `SELECT t.pack_id, t.deal_kind, t.threshold, t.currency, t.comparator,
              t.diligence, t.cash_only, p.id_threshold
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
    expect(canadaFx.comparator).toBe("gte");
    expect(canadaFx.diligence).toBe("identify");
    expect(canadaFx.cash_only).toBe(false);
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
      windowDays: null,
      comparator: "gt",
      direction: "out",
      thresholdCurrency: "EUR",
      cashOnly: false,
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

    await pool.query(
      `INSERT INTO jurisdiction_reports
         (report_id, pack_id, code, name, kind, deadline_value, deadline_unit,
          window_kind, window_days, comparator, cash_only)
       VALUES
         ('rpt-imm','pack-probe-v1','IMM','Immediate','suspicious',
          NULL,'immediately','banking_day',NULL,'gte',false),
         ('rpt-hrs','pack-probe-v1','HRS','Hours','suspicious',
          24,'hours','rolling_days',30,'gt',true),
         ('rpt-nth','pack-probe-v1','NTH','Monthly','suspicious',
          15,'monthly_day','none',NULL,'gte',false),
         ('rpt-before','pack-probe-v1','BEF','Before','suspicious',
          NULL,'before_execution','none',NULL,'gte',true)`,
    );
    const shaped = async (id: string) =>
      reportRuleFields(
        (
          await pool.query(
            `SELECT deadline_value, deadline_unit, window_kind, window_days,
                    comparator, direction, threshold_currency, cash_only
               FROM jurisdiction_reports WHERE report_id=$1`,
            [id],
          )
        ).rows[0],
      );
    expect(await shaped("rpt-imm")).toMatchObject({
      deadlineUnit: "immediately",
      deadlineValue: null,
      windowKind: "banking_day",
      windowDays: null,
    });
    expect(await shaped("rpt-hrs")).toMatchObject({
      deadlineUnit: "hours",
      deadlineValue: 24,
      windowKind: "rolling_days",
      windowDays: 30,
      comparator: "gt",
      cashOnly: true,
    });
    expect(await shaped("rpt-nth")).toMatchObject({
      deadlineUnit: "monthly_day",
      deadlineValue: 15,
    });
    expect(await shaped("rpt-before")).toMatchObject({
      deadlineUnit: "before_execution",
      deadlineValue: null,
      cashOnly: true,
    });

    await pool.query(
      `UPDATE jurisdiction_id_thresholds
          SET comparator='gt', diligence='edd', cash_only=true
        WHERE pack_id='pack-probe-v1' AND deal_kind='fx'`,
    );
    const fx = (
      await pool.query(
        `SELECT threshold, comparator, diligence, cash_only
           FROM jurisdiction_id_thresholds
          WHERE pack_id='pack-probe-v1' AND deal_kind='fx'`,
      )
    ).rows[0];
    expect(fx.comparator).toBe("gt");
    expect(fx.diligence).toBe("edd");
    expect(fx.cash_only).toBe(true);
    expect(idLineAmount(fx.threshold)).toBe("0.00");

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

  it("gives a blank country and an unknown country no pack, no FINTRAC and no CAD", async () => {
    for (const [slug, country] of [
      ["pack-blank-country", ""],
      ["pack-rs", "RS"],
    ] as const) {
      await clearDesk(slug);
      const setup: Record<string, unknown> = { country };
      await provisionDesk(
        handle.db,
        {
          businessName: "Unknown Desk",
          legalName: "Unknown Desk Inc.",
          ownerName: "Owner",
          email: `${slug}@example.test`,
          slug,
          plan: "pro",
          setup,
          msbNumber: null,
          regulator: "",
          team: [],
        },
        "hash",
        "test",
      );
      expect(setup.rulesUnavailable).toBe(true);
      expect(setup.homeCurrency ?? "").not.toBe("CAD");
      const entity = (
        await pool.query(
          `SELECT jurisdiction, jurisdiction_pack_id, home_currency
             FROM legal_entities WHERE id=$1`,
          [`le-${slug}`],
        )
      ).rows[0];
      expect(entity.jurisdiction).not.toBe("FINTRAC");
      expect(entity.jurisdiction_pack_id).toBeNull();
      expect(entity.home_currency).toBeNull();
    }
  });

const migrationSql = readFileSync(
  new URL("../src/db/migrations/028_pack_rule_fields.sql", import.meta.url),
  "utf8",
);
const migrationSlice = (name: string) => {
  const start = migrationSql.indexOf(`-- ${name}:start`);
  const end = migrationSql.indexOf(`-- ${name}:end`);
  if (start < 0 || end < start) throw new Error(`missing ${name} slice`);
  return migrationSql.slice(start, end);
};

  it("assigns a pack from home currency, and only once", async () => {
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (message: { message?: string }) => {
      notices.push(message.message ?? "");
    };
    client.on("notice", onNotice);
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO tenants (id, name) VALUES ('tnt-backfill', 'Backfill')`,
      );
      await client.query(
        `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id)
         VALUES
           ('le-bf-cad','tnt-backfill','CAD desk','x','CAD',NULL),
           ('le-bf-empty','tnt-backfill','Empty desk','x',NULL,NULL),
           ('le-bf-gbp','tnt-backfill','GBP desk','x','GBP',NULL),
           ('le-bf-aud','tnt-backfill','AUD desk','x','AUD',NULL),
           ('le-bf-aed','tnt-backfill','AED desk','x','AED',NULL),
           ('le-bf-eur','tnt-backfill','EUR desk','x','EUR',NULL),
           ('le-bf-usd','tnt-backfill','USD desk','x','USD',NULL),
           ('le-bf-rsd','tnt-backfill','RSD desk','x','RSD',NULL),
           ('le-bf-kept','tnt-backfill','Already packed','x','CAD','pack-us-v1')`,
      );
      await client.query(
        `INSERT INTO ledger_principals
           (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
         VALUES ('user-orphan','tnt-backfill','le-does-not-exist','br','ws','till','teller','[]')`,
      );
      await client.query(migrationSlice("pack-backfill"));
      const packOf = async (id: string) =>
        (
          await client.query(
            `SELECT jurisdiction_pack_id, jurisdiction_pack_version
               FROM legal_entities WHERE id=$1`,
            [id],
          )
        ).rows[0];
      expect((await packOf("le-bf-cad")).jurisdiction_pack_id).toBe("pack-ca-v1");
      expect(Number((await packOf("le-bf-cad")).jurisdiction_pack_version)).toBe(1);
      expect((await packOf("le-bf-empty")).jurisdiction_pack_id).toBe("pack-ca-v1");
      expect((await packOf("le-bf-gbp")).jurisdiction_pack_id).toBe("pack-gb-v1");
      expect((await packOf("le-bf-aud")).jurisdiction_pack_id).toBe("pack-au-v1");
      expect((await packOf("le-bf-aed")).jurisdiction_pack_id).toBe("pack-ae-v1");
      expect((await packOf("le-bf-eur")).jurisdiction_pack_id).toBe("pack-eu-v1");
      expect((await packOf("le-bf-usd")).jurisdiction_pack_id).toBeNull();
      expect((await packOf("le-bf-rsd")).jurisdiction_pack_id).toBeNull();
      expect((await packOf("le-bf-kept")).jurisdiction_pack_id).toBe("pack-us-v1");
      const stillMissing = await client.query(
        `SELECT 1 FROM legal_entities WHERE id='le-does-not-exist'`,
      );
      expect(stillMissing.rowCount).toBe(0);
      expect(notices.some((line) => line.includes("pack backfill:"))).toBe(true);

      notices.length = 0;
      await client.query(migrationSlice("pack-backfill"));
      expect((await packOf("le-bf-cad")).jurisdiction_pack_id).toBe("pack-ca-v1");
      expect((await packOf("le-bf-usd")).jurisdiction_pack_id).toBeNull();
      expect(notices.some((line) => /pack backfill: 0 legal_entities/.test(line))).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      client.removeListener("notice", onNotice);
      client.release();
    }
  });

  it("refuses to label an aggregation window that is not 24 hours", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE jurisdiction_reports
            SET aggregation_hours = 48
          WHERE pack_id = 'pack-ca-v1' AND code = 'LCTR'`,
      );
      await expect(client.query(migrationSlice("aggregation-guard"))).rejects.toThrow(
        /not 24/,
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("does not copy a zero identification line into the per-deal table", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO jurisdiction_packs
           (pack_id, jurisdiction, version, name, home_currency, regulator,
            report_name, report_threshold, id_threshold, report_currency)
         VALUES ('pack-zero-v1','QZ',1,'Zero','CAD','Z','NIL',10000,0,'CAD')`,
      );
      await client.query(migrationSlice("id-copy"));
      const copied = await client.query(
        `SELECT 1 FROM jurisdiction_id_thresholds WHERE pack_id='pack-zero-v1'`,
      );
      expect(copied.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
