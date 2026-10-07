/* The Singapore pack, on Postgres. Migration 039 inserts it. A
   Canada desk stays on the Canada pack. A new signup in Singapore
   opens on pack-sg-v1, in SGD. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { previewSingaporeIdentification, requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { singaporeDealSgd } from "../src/ledger/singapore-pack.js";
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
  userId: "user-sg",
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

postgres("Singapore pack against real PostgreSQL", () => {
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
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-sg-pack','Singapore') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-sg-pack','tnt-le-sg-pack','Singapore','MAS / STRO','SGD','pack-sg-v1',1)
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-ca-sg','Canada') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-ca-sg','tnt-le-ca-sg','Canada','FINTRAC','CAD','pack-ca-v1',1)
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

  it("stores the Singapore pack and leaves every other hour window at 24", async () => {
    const pack = await pool.query(
      `SELECT home_currency, regulator, report_name, report_threshold, id_threshold,
              report_currency, aggregation_hours, retention_years, kind
         FROM jurisdiction_packs WHERE pack_id = 'pack-sg-v1'`,
    );
    expect(pack.rows[0]).toMatchObject({
      home_currency: "SGD",
      regulator: "MAS / STRO",
      report_name: "Suspicious Transaction Report",
      report_threshold: "0.00",
      id_threshold: "5000.00",
      report_currency: "SGD",
      aggregation_hours: null,
      retention_years: 5,
      kind: "country",
    });
    const others = await pool.query(
      `SELECT pack_id, aggregation_hours FROM jurisdiction_packs
        WHERE pack_id <> 'pack-sg-v1' ORDER BY pack_id`,
    );
    expect(others.rows.length).toBeGreaterThan(0);
    const nullWindow = new Set(["pack-eu-v2", "pack-rs-v1", "pack-in-v1", "pack-ph-v1"]);
    for (const row of others.rows) {
      if (nullWindow.has(row.pack_id)) {
        expect(row.aggregation_hours, row.pack_id).toBeNull();
      } else {
        expect(row.aggregation_hours, row.pack_id).toBe(24);
      }
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
         FROM jurisdiction_id_thresholds WHERE pack_id = 'pack-sg-v1' ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "5000.00", comparator: "gt", diligence: "cdd", currency: "SGD" },
      { deal_kind: "fx", threshold: "5000.00", comparator: "gt", diligence: "cdd", currency: "SGD" },
      { deal_kind: "remittance", threshold: null, comparator: "gte", diligence: "cdd", currency: null },
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, window_kind, deadline_value, deadline_unit, filing_format
         FROM jurisdiction_reports WHERE pack_id = 'pack-sg-v1' ORDER BY code`,
    );
    expect(reports.rows).toEqual([
      {
        code: "STR",
        kind: "suspicious",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
      },
      {
        code: "WIRE-INFO",
        kind: "other",
        trigger_threshold: null,
        window_kind: "none",
        deadline_value: null,
        deadline_unit: null,
        filing_format: null,
      },
    ]);
    const cash = await pool.query(
      `SELECT count(*)::int AS n FROM jurisdiction_reports
        WHERE pack_id = 'pack-sg-v1' AND kind = 'large_cash'`,
    );
    expect(cash.rows[0].n).toBe(0);
  });

  it("does not move a Canada desk, and reads no hour window and no cash line", async () => {
    const client = await pool.connect();
    try {
      const sg = await resolvePack(client, "le-sg-pack");
      expect(sg.packId).toBe("pack-sg-v1");
      expect(sg.homeCurrency).toBe("SGD");
      const desk = await readDeskThresholds(client, "le-sg-pack", sg);
      expect(desk.aggregationHours.packValue).toBeNull();
      expect(desk.aggregationHours.effective).toBeNull();
      expect(desk.retentionYears.effective).toBe(5);
      expect(desk.idThreshold.effective).toBe("5000.00");
      expect(desk.reportThreshold.effective).toBeNull();
      expect(desk.remittanceIdThreshold.effective).toBeNull();
      const canada = await resolvePack(client, "le-ca-sg");
      expect(canada.packId).toBe("pack-ca-v1");
      const canadaDesk = await readDeskThresholds(client, "le-ca-sg", canada);
      expect(canadaDesk.aggregationHours.effective).toBe(24);
      expect(canadaDesk.reportThreshold.effective).toBe("10000.00");
      expect(canadaDesk.idThreshold.effective).toBe("3000.00");
    } finally {
      client.release();
    }
  });

  it("blocks on the lines, and a stored remittance cell cannot turn the transfer off", async () => {
    const client = await pool.connect();
    const ask = (amount: string, kind: string, status: string) =>
      requireIdentification(client, actor("le-sg-pack"), 
        { packId: "pack-sg-v1", available: true, baseline: false, homeCurrency: "SGD" } as never,
        new Decimal(amount),
        status,
        { kind, cash: true },
      );
    try {
      const pack = await resolvePack(client, "le-sg-pack");
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("5000"), "unverified", { kind: "exchange", cash: true })).resolves.toBeTruthy();
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("5000.01"), "unverified", { kind: "exchange", cash: true })).rejects.toThrow(/blocked posting/);
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("5000"), "unverified", { kind: "money_order", cash: true })).resolves.toBeTruthy();
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("5000.01"), "unverified", { kind: "money_order", cash: true })).rejects.toThrow(/blocked posting/);
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("0.01"), "unverified", { kind: "remittance_send", cash: true })).rejects.toThrow(/blocked posting/);
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("9000"), "unverified", { kind: "cheque_cashing", cash: true })).resolves.toBeTruthy();
      await expect(requireIdentification(client, actor("le-sg-pack"), pack, new Decimal("0.01"), "verified", { kind: "remittance_send", cash: true })).resolves.toBeTruthy();

      await pool.query(
        `UPDATE jurisdiction_id_thresholds
            SET threshold = 0, currency = 'SGD'
          WHERE pack_id = 'pack-sg-v1' AND deal_kind = 'remittance'`,
      );
      await expect(ask("0.01", "remittance_receive", "unverified")).rejects.toThrow(/blocked posting/);
      await pool.query(
        `UPDATE jurisdiction_id_thresholds SET threshold = 5000, currency = 'SGD'
          WHERE pack_id = 'pack-sg-v1' AND deal_kind = 'remittance'`,
      );
      await expect(ask("0.01", "remittance", "unverified")).rejects.toThrow(/blocked posting/);
    } finally {
      await pool.query(
        `UPDATE jurisdiction_id_thresholds
            SET threshold = NULL, currency = NULL
          WHERE pack_id = 'pack-sg-v1' AND deal_kind = 'remittance'`,
      );
      client.release();
    }
  });

  it("the screen's read uses the same line, and 5000 SGD is not over it", async () => {
    const client = await pool.connect();
    try {
      const decisions = await previewSingaporeIdentification(client, actor("le-sg-pack"), [
        { key: "exact", dealKind: "fx", from: "SGD", to: "USD", inputAmount: new Decimal("5000.00"), outputAmount: null },
        { key: "over", dealKind: "fx", from: "SGD", to: "USD", inputAmount: new Decimal("5000.01"), outputAmount: null },
        { key: "small", dealKind: "fx", from: "SGD", to: "USD", inputAmount: new Decimal("10.00"), outputAmount: null },
        { key: "wire", dealKind: "remittance_send", from: "SGD", to: "USD", inputAmount: new Decimal("10.00"), outputAmount: null },
        { key: "cheque", dealKind: "cheque_cashing", from: "SGD", to: "USD", inputAmount: new Decimal("9000.00"), outputAmount: null },
      ]);
      expect(decisions).toEqual([
        { key: "exact", identificationRequired: false },
        { key: "over", identificationRequired: true },
        { key: "small", identificationRequired: false },
        { key: "wire", identificationRequired: true },
        { key: "cheque", identificationRequired: false },
      ]);
      await expect(previewSingaporeIdentification(client, actor("le-ca-sg"), [
        { key: "no", dealKind: "fx", from: "CAD", to: "USD", inputAmount: new Decimal("10.00"), outputAmount: null },
      ])).rejects.toThrow(/not on the Singapore pack/);
    } finally {
      client.release();
    }
  });

  it("refuses a book that is not SGD", async () => {
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, "le-sg-pack");
      await expect(requireIdentification(
        client,
        actor("le-sg-pack"),
        { ...pack, homeCurrency: "USD" },
        new Decimal("10"),
        "verified",
        { kind: "exchange", cash: true },
      )).rejects.toThrow(/not keeping its book in SGD/);
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
      /* A fresh snapshot left by another suite would price this cross.
         Park every row as stale, then prove a cross with no fresh mid
         comes back unpriced. Restore those timestamps afterwards. */
      await pool.query(
        `UPDATE market_rates SET fetched_at = now() - interval '48 hours'`,
      );
      await pool.query(`DELETE FROM market_rates WHERE id = 'snap-sg'`);
      const missing = await singaporeDealSgd(client, {
        from: "EUR",
        to: "USD",
        inputAmount: new Decimal("100"),
        outputAmount: new Decimal("110"),
      });
      expect(missing).toBeNull();
      await pool.query(
        `INSERT INTO market_rates (id, provider, mids, fetched_at)
         VALUES ('snap-sg', 'test', $1::jsonb, now())`,
        [JSON.stringify({ USD: "1.36", SGD: "1.00", EUR: "1.47" })],
      );
      const priced = await singaporeDealSgd(client, {
        from: "EUR",
        to: "USD",
        inputAmount: new Decimal("100"),
        outputAmount: new Decimal("110"),
      });
      expect(priced).toBeTruthy();
      /* 100 EUR at 1.47 CAD per EUR and 1.00 CAD per SGD is 147 SGD. */
      expect(priced!.sgd.toFixed(2)).toBe("147.00");
      expect(priced!.sgd.gt("5000")).toBe(false);
      const exact = await singaporeDealSgd(client, {
        from: "SGD",
        to: "USD",
        inputAmount: new Decimal("5000"),
        outputAmount: new Decimal("3700"),
      });
      expect(exact!.sgd.toFixed(2)).toBe("5000.00");
    } finally {
      await pool.query(`DELETE FROM market_rates WHERE id = 'snap-sg'`);
      for (const row of parked.rows) {
        await pool.query(
          `UPDATE market_rates SET fetched_at = $2 WHERE id = $1`,
          [row.id, row.fetched_at],
        );
      }
      client.release();
    }
  });

  it("signs a new Singapore shop onto the pack", async () => {
    const started = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Boat Quay FX",
        ownerName: "Asha Lim",
        email: "asha@boatquay.example",
        password: "a-strong-pass",
        slug: "boatquayfx",
        onboarding: { country: "Singapore" },
      },
    });
    expect(started.statusCode).toBe(201);
    const verified = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "asha@boatquay.example", code: codeFromLog() },
    });
    expect(verified.statusCode).toBe(201);
    const le = (await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-boatquayfx")))[0]!;
    expect(le.jurisdictionPackId).toBe("pack-sg-v1");
    expect(le.homeCurrency).toBe("SGD");
    expect(le.jurisdiction).not.toBe("FINTRAC");
  });
});
