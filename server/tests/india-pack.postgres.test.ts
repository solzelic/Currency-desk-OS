/* The India pack, on Postgres. Migration 037 inserts it. A Canada desk
   and a desk with no country stay where they were. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { indiaSaleCashBlocked } from "../src/ledger/india-pack.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

const actor = (legalEntityId: string): LedgerActor => ({
  userId: "user-in",
  tenantId: `tnt-${legalEntityId}`,
  legalEntityId,
  branchId: "br",
  workspaceId: "ws",
  tillId: "till",
  role: "owner",
  authorizedBranchIds: ["br"],
});

postgres("India pack against real PostgreSQL", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-in-pack','India') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-in-pack','tnt-le-in-pack','India','RBI / FIU-IND','INR','pack-in-v1',1)
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-ca-still','Canada') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-ca-still','tnt-le-ca-still','Canada','FINTRAC','CAD','pack-ca-v1',1)
       ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("stores the India pack and does not blank anyone else's hour window", async () => {
    const pack = await pool.query(
      `SELECT home_currency, regulator, report_name, report_threshold, id_threshold,
              report_currency, aggregation_hours, retention_years, kind
         FROM jurisdiction_packs WHERE pack_id = 'pack-in-v1'`,
    );
    expect(pack.rows[0]).toMatchObject({
      home_currency: "INR",
      regulator: "RBI / FIU-IND",
      report_name: "Currency Transaction Report",
      report_threshold: "1000000.00",
      id_threshold: "50000.00",
      report_currency: "INR",
      aggregation_hours: null,
      retention_years: 5,
      kind: "country",
    });
    const others = await pool.query(
      `SELECT pack_id, aggregation_hours FROM jurisdiction_packs
        WHERE pack_id <> 'pack-in-v1' ORDER BY pack_id`,
    );
    expect(others.rows.length).toBeGreaterThan(0);
    for (const row of others.rows) {
      expect(row.aggregation_hours, row.pack_id).toBe(24);
    }
    const canada = await pool.query(
      `SELECT report_threshold, id_threshold FROM jurisdiction_packs WHERE pack_id = 'pack-ca-v1'`,
    );
    expect(canada.rows[0]).toMatchObject({
      report_threshold: "10000.00",
      id_threshold: "3000.00",
    });
  });

  it("splits identification and lists the four reports", async () => {
    const lines = await pool.query(
      `SELECT deal_kind, threshold, comparator, diligence
         FROM jurisdiction_id_thresholds WHERE pack_id = 'pack-in-v1' ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "0.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "fx", threshold: "50000.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "remittance", threshold: "0.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "virtual_currency", threshold: "50000.00", comparator: "gte", diligence: "cdd" },
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, comparator, window_kind, deadline_value, deadline_unit
         FROM jurisdiction_reports WHERE pack_id = 'pack-in-v1' ORDER BY code`,
    );
    expect(reports.rows).toEqual([
      {
        code: "CBWTR",
        kind: "wire",
        trigger_threshold: "500000.00",
        comparator: "gt",
        window_kind: "calendar_month",
        deadline_value: 15,
        deadline_unit: "monthly_day",
      },
      {
        code: "CCR",
        kind: "other",
        trigger_threshold: null,
        comparator: "gte",
        window_kind: "none",
        deadline_value: 15,
        deadline_unit: "monthly_day",
      },
      {
        code: "CTR",
        kind: "large_cash",
        trigger_threshold: "1000000.00",
        comparator: "gt",
        window_kind: "calendar_month",
        deadline_value: 15,
        deadline_unit: "monthly_day",
      },
      {
        code: "STR",
        kind: "suspicious",
        trigger_threshold: null,
        comparator: "gte",
        window_kind: "none",
        deadline_value: 7,
        deadline_unit: "business_days",
      },
    ]);
  });

  it("does not move a Canada desk, and reads no hour window for India", async () => {
    const client = await pool.connect();
    try {
      const india = await resolvePack(client, "le-in-pack");
      expect(india.packId).toBe("pack-in-v1");
      expect(india.homeCurrency).toBe("INR");
      const desk = await readDeskThresholds(client, "le-in-pack", india);
      expect(desk.aggregationHours.packValue).toBeNull();
      expect(desk.aggregationHours.effective).toBeNull();
      expect(desk.retentionYears.effective).toBe(5);
      expect(desk.idThreshold.effective).toBe("50000.00");
      expect(desk.reportThreshold.effective).toBe("1000000.00");
      const canada = await resolvePack(client, "le-ca-still");
      expect(canada.packId).toBe("pack-ca-v1");
      const canadaDesk = await readDeskThresholds(client, "le-ca-still", canada);
      expect(canadaDesk.aggregationHours.effective).toBe(24);
      expect(canadaDesk.idThreshold.effective).toBe("3000.00");
      expect(canadaDesk.reportThreshold.effective).toBe("10000.00");
    } finally {
      client.release();
    }
  });

  it("identifies a walk-in at 50,000 and every remittance, and blocks a cash sale", async () => {
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, "le-in-pack");
      const who = actor("le-in-pack");
      await expect(
        requireIdentification(client, who, pack, new Decimal("49999.99"), "unverified", {
          kind: "exchange",
          cash: true,
        }),
      ).resolves.toMatchObject({ rate: "1.000000000000" });
      await expect(
        requireIdentification(client, who, pack, new Decimal("50000.00"), "unverified", {
          kind: "exchange",
          cash: true,
        }),
      ).rejects.toThrow(/blocked posting/);
      await expect(
        requireIdentification(client, who, pack, new Decimal("1.00"), "unverified", {
          kind: "remittance_send",
          cash: true,
        }),
      ).rejects.toThrow(/blocked posting/);
      await expect(
        requireIdentification(client, who, pack, new Decimal("1.00"), "verified", {
          kind: "remittance_send",
          cash: true,
        }),
      ).resolves.toBeTruthy();
      expect(indiaSaleCashBlocked({
        packId: pack.packId,
        from: "INR",
        to: "USD",
        inputAmount: new Decimal("50000"),
        home: pack.homeCurrency,
      })).toBe(true);
      /* A purchase pays foreign currency in and rupees out. No residency
         is on the customer, so a payout over 1,000 USD is not refused here. */
      expect(indiaSaleCashBlocked({
        packId: pack.packId,
        from: "USD",
        to: "INR",
        inputAmount: new Decimal("2000"),
        home: pack.homeCurrency,
      })).toBe(false);
    } finally {
      client.release();
    }
  });
});
