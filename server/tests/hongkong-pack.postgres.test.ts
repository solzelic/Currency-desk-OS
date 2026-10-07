/* The Hong Kong pack, on Postgres. Migration 040 inserts it. A
   Canada desk stays on the Canada pack. A new signup in Hong Kong
   opens on pack-hk-v1, in HKD. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { hongKongDealHkd } from "../src/ledger/hongkong-pack.js";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let earlyAccess: string | undefined;

const actor = (legalEntityId: string): LedgerActor => ({
  userId: "user-hk",
  tenantId: `tnt-${legalEntityId}`,
  legalEntityId,
  branchId: "br",
  workspaceId: "ws",
  tillId: "till",
  role: "owner",
  authorizedBranchIds: ["br"],
});

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((entry) => entry.includes("[email simulated]"));
  const match = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!match) throw new Error("no signup code in log");
  return match[1]!;
};

postgres("Hong Kong pack against real PostgreSQL", () => {
  beforeAll(async () => {
    earlyAccess = process.env.EARLY_ACCESS_OPEN;
    process.env.EARLY_ACCESS_OPEN = "1";
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    app = await buildApp(handle.db);
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-hk-pack','Hong Kong') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-hk-pack','tnt-le-hk-pack','Hong Kong','C&ED / JFIU','HKD','pack-hk-v1',1)
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-ca-hk','Canada') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-ca-hk','tnt-le-ca-hk','Canada','FINTRAC','CAD','pack-ca-v1',1)
       ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    process.env.EARLY_ACCESS_OPEN = earlyAccess;
    delete process.env.DATABASE_URL;
    delete process.env.LEDGER_DATABASE_URL;
    vi.restoreAllMocks();
  });

  it("stores the Hong Kong pack and leaves every other hour window at 24", async () => {
    const pack = await pool.query(
      `SELECT home_currency, regulator, report_name, report_threshold, id_threshold,
              report_currency, aggregation_hours, retention_years, kind
         FROM jurisdiction_packs WHERE pack_id = 'pack-hk-v1'`,
    );
    expect(pack.rows[0]).toMatchObject({
      home_currency: "HKD",
      regulator: "C&ED / JFIU",
      report_name: "Suspicious Transaction Report",
      report_threshold: "0.00",
      id_threshold: "120000.00",
      report_currency: "HKD",
      aggregation_hours: null,
      retention_years: 5,
      kind: "country",
    });
    const others = await pool.query(
      `SELECT pack_id, aggregation_hours FROM jurisdiction_packs
        WHERE pack_id <> 'pack-hk-v1' ORDER BY pack_id`,
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

  it("splits identification and does not seed a cash report", async () => {
    const lines = await pool.query(
      `SELECT deal_kind, threshold, comparator, diligence, currency
         FROM jurisdiction_id_thresholds WHERE pack_id = 'pack-hk-v1' ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "8000.00", comparator: "gte", diligence: "cdd", currency: "HKD" },
      { deal_kind: "fx", threshold: "120000.00", comparator: "gte", diligence: "cdd", currency: "HKD" },
      { deal_kind: "remittance", threshold: "8000.00", comparator: "gte", diligence: "cdd", currency: "HKD" },
      { deal_kind: "virtual_currency", threshold: "8000.00", comparator: "gte", diligence: "cdd", currency: "HKD" },
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, window_kind, deadline_value, deadline_unit, filing_format,
              format_rules->>'status' AS status
         FROM jurisdiction_reports WHERE pack_id = 'pack-hk-v1' ORDER BY code`,
    );
    expect(reports.rows).toEqual([
      {
        code: "REMIT-RECORD",
        kind: "other",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
        status: "Gap",
      },
      {
        code: "STR",
        kind: "suspicious",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
        status: "Listed",
      },
      {
        code: "VA-INFO",
        kind: "other",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
        status: "Gap",
      },
      {
        code: "WIRE-INFO",
        kind: "other",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
        status: "Gap",
      },
    ]);
    const cash = await pool.query(
      `SELECT count(*)::int AS n FROM jurisdiction_reports
        WHERE pack_id = 'pack-hk-v1' AND kind = 'large_cash'`,
    );
    expect(cash.rows[0].n).toBe(0);
  });

  it("does not move a Canada desk, and reads no hour window and no cash line", async () => {
    const client = await pool.connect();
    try {
      const hk = await resolvePack(client, "le-hk-pack");
      expect(hk.packId).toBe("pack-hk-v1");
      expect(hk.homeCurrency).toBe("HKD");
      const desk = await readDeskThresholds(client, "le-hk-pack", hk);
      expect(desk.aggregationHours.packValue).toBeNull();
      expect(desk.aggregationHours.effective).toBeNull();
      expect(desk.retentionYears.effective).toBe(5);
      expect(desk.idThreshold.effective).toBe("120000.00");
      expect(desk.reportThreshold.effective).toBeNull();
      expect(desk.remittanceIdThreshold.effective).toBe("8000.00");
      const canada = await resolvePack(client, "le-ca-hk");
      expect(canada.packId).toBe("pack-ca-v1");
      const canadaDesk = await readDeskThresholds(client, "le-ca-hk", canada);
      expect(canadaDesk.aggregationHours.effective).toBe(24);
      expect(canadaDesk.reportThreshold.effective).toBe("10000.00");
      expect(canadaDesk.idThreshold.effective).toBe("3000.00");
    } finally {
      client.release();
    }
  });

  it("blocks on each line, and a stored 0 or NULL does not turn a check off", async () => {
    const client = await pool.connect();
    const pack = await resolvePack(client, "le-hk-pack");
    const ask = (amount: string, kind: string, status = "unverified") =>
      requireIdentification(
        client,
        actor("le-hk-pack"),
        pack,
        new Decimal(amount),
        status,
        { kind, cash: true },
      );
    try {
      await expect(ask("119999.99", "exchange")).resolves.toBeTruthy();
      await expect(ask("120000", "exchange")).rejects.toThrow(/blocked posting/);
      await expect(ask("120000", "exchange", "verified")).resolves.toBeTruthy();
      for (const kind of ["cheque_cashing", "bill_payment", "money_order"]) {
        await expect(ask("119999.99", kind), kind).resolves.toBeTruthy();
        await expect(ask("120000", kind), kind).rejects.toThrow(/blocked posting/);
      }
      for (const kind of ["remittance", "remittance_send", "remittance_receive", "eft", "virtual_currency"]) {
        await expect(ask("0.01", kind), kind).resolves.toBeTruthy();
        await expect(ask("7999.99", kind), kind).resolves.toBeTruthy();
        await expect(ask("8000", kind), kind).rejects.toThrow(/blocked posting/);
      }
      await expect(ask("-1", "exchange")).rejects.toThrow(/blocked posting/);

      await pool.query(
        `UPDATE jurisdiction_id_thresholds SET threshold = 0
          WHERE pack_id = 'pack-hk-v1' AND deal_kind = 'remittance'`,
      );
      await expect(ask("0.01", "remittance")).rejects.toThrow(/blocked posting/);
      await pool.query(
        `UPDATE jurisdiction_id_thresholds SET threshold = NULL
          WHERE pack_id = 'pack-hk-v1' AND deal_kind = 'remittance'`,
      );
      await expect(ask("0.01", "remittance_receive")).rejects.toThrow(/blocked posting/);
      await pool.query(
        `UPDATE jurisdiction_id_thresholds SET threshold = 8000
          WHERE pack_id = 'pack-hk-v1' AND deal_kind = 'remittance'`,
      );

      await pool.query(
        `DELETE FROM jurisdiction_id_thresholds
          WHERE pack_id = 'pack-hk-v1' AND deal_kind = 'virtual_currency'`,
      );
      await expect(ask("0.01", "virtual_currency")).rejects.toThrow(/blocked posting/);
      await pool.query(
        `INSERT INTO jurisdiction_id_thresholds
           (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
         VALUES ('pack-hk-v1', 'virtual_currency', 8000, 'HKD', 'gte', 'cdd', false)`,
      );

      await pool.query(
        `UPDATE legal_entities SET id_threshold = 50000 WHERE id = 'le-hk-pack'`,
      );
      await expect(ask("50000", "exchange")).rejects.toThrow(/blocked posting/);
      await expect(ask("49999.99", "exchange")).resolves.toBeTruthy();
      await expect(ask("7999.99", "remittance")).resolves.toBeTruthy();
      await expect(ask("8000", "remittance")).rejects.toThrow(/blocked posting/);
      await pool.query(
        `UPDATE legal_entities SET id_threshold = 1000 WHERE id = 'le-hk-pack'`,
      );
      await expect(ask("1000", "remittance")).rejects.toThrow(/blocked posting/);
      await expect(ask("999.99", "eft")).resolves.toBeTruthy();
      await pool.query(
        `UPDATE legal_entities SET id_threshold = 200000 WHERE id = 'le-hk-pack'`,
      );
      await expect(ask("119999.99", "exchange")).resolves.toBeTruthy();
      await expect(ask("7999.99", "virtual_currency")).resolves.toBeTruthy();
      await pool.query(
        `UPDATE legal_entities SET id_threshold = NULL WHERE id = 'le-hk-pack'`,
      );
    } finally {
      await pool.query(
        `UPDATE jurisdiction_id_thresholds SET threshold = 8000, currency = 'HKD', comparator = 'gte'
          WHERE pack_id = 'pack-hk-v1' AND deal_kind = 'remittance'`,
      );
      await pool.query(
        `INSERT INTO jurisdiction_id_thresholds
           (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
         VALUES ('pack-hk-v1', 'virtual_currency', 8000, 'HKD', 'gte', 'cdd', false)
         ON CONFLICT (pack_id, deal_kind) DO UPDATE
           SET threshold = 8000, currency = 'HKD', comparator = 'gte'`,
      );
      await pool.query(
        `UPDATE legal_entities SET id_threshold = NULL WHERE id = 'le-hk-pack'`,
      );
      client.release();
    }
  });

  it("refuses a book that is not HKD", async () => {
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, "le-hk-pack");
      await expect(requireIdentification(
        client,
        actor("le-hk-pack"),
        { ...pack, homeCurrency: "USD" },
        new Decimal("10"),
        "verified",
        { kind: "exchange", cash: true },
      )).rejects.toThrow(/not keeping its book in HKD/);
    } finally {
      client.release();
    }
  });

  it("prices a cross from the market snapshot and not from a missing one", async () => {
    const client = await pool.connect();
    const parked = await pool.query<{ id: string; fetched_at: Date }>(
      `SELECT id, fetched_at FROM market_rates`,
    );
    try {
      await pool.query(
        `UPDATE market_rates SET fetched_at = now() - interval '48 hours'`,
      );
      await pool.query(`DELETE FROM market_rates WHERE id = 'snap-hk'`);
      const exact = await hongKongDealHkd(client, {
        from: "HKD",
        to: "USD",
        inputAmount: new Decimal("120000"),
        outputAmount: new Decimal("15000"),
      });
      expect(exact!.hkd.toFixed(2)).toBe("120000.00");
      const missing = await hongKongDealHkd(client, {
        from: "EUR",
        to: "USD",
        inputAmount: new Decimal("100"),
        outputAmount: new Decimal("110"),
      });
      expect(missing).toBeNull();
      await pool.query(
        `INSERT INTO market_rates (id, provider, mids, fetched_at)
         VALUES ('snap-hk', 'test', $1::jsonb, now())`,
        [JSON.stringify({ USD: "1.36", HKD: "1.00", EUR: "1.47" })],
      );
      const priced = await hongKongDealHkd(client, {
        from: "EUR",
        to: "USD",
        inputAmount: new Decimal("100"),
        outputAmount: new Decimal("110"),
      });
      expect(priced).toBeTruthy();
      /* 100 EUR at 1.47 CAD per EUR and 1.00 CAD per HKD is 147 HKD.
         That is under both lines. The shop board is not used. */
      expect(priced!.hkd.toFixed(2)).toBe("147.00");
      expect(priced!.hkd.gte("8000")).toBe(false);
    } finally {
      await pool.query(`DELETE FROM market_rates WHERE id = 'snap-hk'`);
      for (const row of parked.rows) {
        await pool.query(
          `UPDATE market_rates SET fetched_at = $2 WHERE id = $1`,
          [row.id, row.fetched_at],
        );
      }
      client.release();
    }
  });

  it("signs a new Hong Kong shop onto the pack", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Central FX",
        ownerName: "Mei Chan",
        email: "mei@centralfx.example",
        password: "a-strong-pass",
        slug: "centralfx",
        onboarding: { country: "Hong Kong" },
      },
    });
    expect(started.statusCode).toBe(201);
    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "mei@centralfx.example", code: codeFromLog() },
    });
    expect(verified.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-centralfx")))[0]!;
    expect(le.jurisdictionPackId).toBe("pack-hk-v1");
    expect(le.homeCurrency).toBe("HKD");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.idThreshold).toBeNull();
  });
});
