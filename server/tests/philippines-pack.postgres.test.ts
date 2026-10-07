/* The Philippines pack, on Postgres. Migration 038 inserts it. A
   Canada desk stays on the Canada pack. A new signup in the
   Philippines opens on pack-ph-v1, in pesos. */
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
import {
  philippinesCashPayout,
  philippinesDealPesos,
  philippinesFxSale,
} from "../src/ledger/philippines-pack.js";
import * as schema from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let earlyAccess: string | undefined;

const actor = (legalEntityId: string): LedgerActor => ({
  userId: "user-ph",
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

postgres("Philippines pack against real PostgreSQL", () => {
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
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-ph-pack','Philippines') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-ph-pack','tnt-le-ph-pack','Philippines','BSP / AMLC','PHP','pack-ph-v1',1)
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ('tnt-le-ca-ph','Canada') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ('le-ca-ph','tnt-le-ca-ph','Canada','FINTRAC','CAD','pack-ca-v1',1)
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

  it("stores the Philippines pack and leaves every other hour window at 24", async () => {
    const pack = await pool.query(
      `SELECT home_currency, regulator, report_name, report_threshold, id_threshold,
              report_currency, aggregation_hours, retention_years, kind
         FROM jurisdiction_packs WHERE pack_id = 'pack-ph-v1'`,
    );
    expect(pack.rows[0]).toMatchObject({
      home_currency: "PHP",
      regulator: "BSP / AMLC",
      report_name: "Covered Transaction Report",
      report_threshold: "500000.00",
      id_threshold: "5000.00",
      report_currency: "PHP",
      aggregation_hours: null,
      retention_years: 5,
      kind: "country",
    });
    const others = await pool.query(
      `SELECT pack_id, aggregation_hours FROM jurisdiction_packs
        WHERE pack_id <> 'pack-ph-v1' ORDER BY pack_id`,
    );
    expect(others.rows.length).toBeGreaterThan(0);
    /* Serbia, the 2027 EU pack, India, and Singapore store NULL on
       purpose. NULL is not a missing 24. Every other pack still stores
       24. The Philippines pack must not have cleared those. */
    const nullWindow = new Set(["pack-eu-v2", "pack-rs-v1", "pack-in-v1", "pack-sg-v1"]);
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

  it("splits identification and lists the two reports", async () => {
    const lines = await pool.query(
      `SELECT deal_kind, threshold, comparator, diligence, currency
         FROM jurisdiction_id_thresholds WHERE pack_id = 'pack-ph-v1' ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "100000.00", comparator: "gt", diligence: "cdd", currency: "PHP" },
      { deal_kind: "fx", threshold: "5000.00", comparator: "gt", diligence: "cdd", currency: "PHP" },
      { deal_kind: "remittance", threshold: "5000.00", comparator: "gt", diligence: "cdd", currency: "PHP" },
      { deal_kind: "virtual_currency", threshold: "100000.00", comparator: "gt", diligence: "cdd", currency: "PHP" },
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, comparator, window_kind, deadline_value, deadline_unit, cash_only
         FROM jurisdiction_reports WHERE pack_id = 'pack-ph-v1' ORDER BY code`,
    );
    expect(reports.rows).toEqual([
      {
        code: "CTR",
        kind: "large_cash",
        trigger_threshold: "500000.00",
        comparator: "gt",
        window_kind: "banking_day",
        deadline_value: 5,
        deadline_unit: "business_days",
        cash_only: false,
      },
      {
        code: "STR",
        kind: "suspicious",
        trigger_threshold: null,
        comparator: "gte",
        window_kind: "none",
        deadline_value: 1,
        deadline_unit: "business_days",
        cash_only: false,
      },
    ]);
  });

  it("does not move a Canada desk, and reads no hour window for the Philippines", async () => {
    const client = await pool.connect();
    try {
      const ph = await resolvePack(client, "le-ph-pack");
      expect(ph.packId).toBe("pack-ph-v1");
      expect(ph.homeCurrency).toBe("PHP");
      const desk = await readDeskThresholds(client, "le-ph-pack", ph);
      expect(desk.aggregationHours.packValue).toBeNull();
      expect(desk.aggregationHours.effective).toBeNull();
      expect(desk.retentionYears.effective).toBe(5);
      expect(desk.idThreshold.effective).toBe("5000.00");
      expect(desk.reportThreshold.effective).toBe("500000.00");
      const canada = await resolvePack(client, "le-ca-ph");
      expect(canada.packId).toBe("pack-ca-v1");
      const canadaDesk = await readDeskThresholds(client, "le-ca-ph", canada);
      expect(canadaDesk.aggregationHours.effective).toBe(24);
      expect(canadaDesk.idThreshold.effective).toBe("3000.00");
      expect(canadaDesk.reportThreshold.effective).toBe("10000.00");
    } finally {
      client.release();
    }
  });

  it("identifies above 5,000 and above 100,000, and allows a 1 peso remittance", async () => {
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, "le-ph-pack");
      const who = actor("le-ph-pack");
      await expect(
        requireIdentification(client, who, pack, new Decimal("1.00"), "unverified", {
          kind: "remittance_send",
          cash: true,
        }),
      ).resolves.toMatchObject({ rate: "1.000000000000" });
      await expect(
        requireIdentification(client, who, pack, new Decimal("5000.00"), "unverified", {
          kind: "exchange",
          cash: true,
        }),
      ).resolves.toBeTruthy();
      await expect(
        requireIdentification(client, who, pack, new Decimal("5000.01"), "unverified", {
          kind: "remittance_receive",
          cash: true,
        }),
      ).rejects.toThrow(/blocked posting/);
      await expect(
        requireIdentification(client, who, pack, new Decimal("100000.00"), "unverified", {
          kind: "cheque_cashing",
          cash: true,
        }),
      ).resolves.toBeTruthy();
      await expect(
        requireIdentification(client, who, pack, new Decimal("100000.01"), "unverified", {
          kind: "bill_payment",
          cash: true,
        }),
      ).rejects.toThrow(/blocked posting/);
      await expect(
        requireIdentification(client, who, pack, new Decimal("5000.01"), "verified", {
          kind: "exchange",
          cash: true,
        }),
      ).resolves.toBeTruthy();
    } finally {
      client.release();
    }
  });

  it("blocks a foreign payout or a non-dollar sale when the rate is missing, and allows the line itself", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO market_rates (id, provider, mids, fetched_at)
         VALUES ('ph-snap','test','{"USD":1.00,"PHP":0.02,"EUR":2.00}', timestamptz '2099-01-01')`,
      );
      /* PHP per USD = 1.00 / 0.02 = 50. 10,000 USD is exactly 500,000 PHP. */
      expect(await philippinesCashPayout(client, "PHP", new Decimal("500000.00"))).toBe("ok");
      expect(await philippinesCashPayout(client, "PHP", new Decimal("500000.01"))).toBe("over");
      expect(await philippinesCashPayout(client, "USD", new Decimal("10000.00"))).toBe("ok");
      expect(await philippinesCashPayout(client, "USD", new Decimal("10000.01"))).toBe("over");
      expect(await philippinesFxSale(client, "PHP", "USD", new Decimal("10000.00"))).toBe("ok");
      expect(await philippinesFxSale(client, "PHP", "USD", new Decimal("10000.01"))).toBe("over");
      /* USD per EUR = 2.00 / 1.00 = 2. 5,000 EUR is exactly 10,000 USD. */
      expect(await philippinesFxSale(client, "PHP", "EUR", new Decimal("5000.00"))).toBe("ok");
      expect(await philippinesFxSale(client, "PHP", "EUR", new Decimal("5000.01"))).toBe("over");
      expect(await philippinesFxSale(client, "USD", "EUR", new Decimal("1"))).toBe("not_a_sale");
      const valued = await philippinesDealPesos(client, {
        from: "EUR",
        to: "USD",
        inputAmount: new Decimal("1"),
        outputAmount: new Decimal("1.1"),
      });
      /* PHP per EUR = 2.00 / 0.02 = 100. */
      expect(valued?.pesos.eq("100")).toBe(true);
      await client.query("DELETE FROM market_rates WHERE id = 'ph-snap'");
      expect(await philippinesCashPayout(client, "USD", new Decimal("1.00"))).toBe("unpriced");
      expect(await philippinesFxSale(client, "PHP", "EUR", new Decimal("1.00"))).toBe("unpriced");
      expect(await philippinesCashPayout(client, "PHP", new Decimal("1.00"))).toBe("ok");
      expect(await philippinesFxSale(client, "PHP", "USD", new Decimal("1.00"))).toBe("ok");
      expect(
        await philippinesDealPesos(client, {
          from: "EUR",
          to: "USD",
          inputAmount: new Decimal("10"),
          outputAmount: new Decimal("11"),
        }),
      ).toBeNull();
      expect(
        (await philippinesDealPesos(client, {
          from: "PHP",
          to: "USD",
          inputAmount: new Decimal("5000.00"),
          outputAmount: new Decimal("90"),
        }))?.pesos.eq("5000"),
      ).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("opens a new Philippines desk on the Philippines pack, in pesos", async () => {
    logged = [];
    const su = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        businessName: "Manila FX",
        ownerName: "Liza Cruz",
        email: "liza@manilafx.ph",
        password: "a-strong-pass",
        slug: "manilafx",
        onboarding: { country: "PH" },
      },
    });
    expect(su.statusCode, su.body).toBe(201);
    const ok = await app.inject({
      method: "POST",
      url: "/api/signup/verify",
      payload: { email: "liza@manilafx.ph", code: codeFromLog() },
    });
    expect(ok.statusCode, ok.body).toBe(201);
    const le = (
      await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-manilafx"))
    )[0]!;
    expect(le.jurisdictionPackId).toBe("pack-ph-v1");
    expect(le.homeCurrency).toBe("PHP");
    expect(le.jurisdiction).toBe("");
    expect(le.jurisdiction).not.toBe("FINTRAC");
    expect(le.jurisdictionPackId).not.toBe("pack-intl-v1");
    expect(le.homeCurrency).not.toBe("CAD");
  });
});
