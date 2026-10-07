/* pack-eu-v2 on Postgres, and the posting gate that reads it.
   pack-eu-v1 is asserted unchanged. A fresh database is required:
   this file leaves an entity behind on purpose, then deletes it. */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { EU_AMLR_PACK_ID, EU_V1_PACK_ID, resolvePack } from "../src/ledger/jurisdiction.js";
import { LedgerError, requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { ThresholdService } from "../src/ledger/threshold-control.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;

const ENTITY = "le-eu-amlr";
const TENANT = "tnt-eu-amlr";
const BRANCH = "br-eu-amlr";
const WORKSPACE = "ws-eu-amlr";
const TILL = "till-eu-amlr";
const USER = "user-eu-amlr";

const actor: LedgerActor = {
  userId: USER,
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: WORKSPACE,
  tillId: TILL,
  role: "administrator",
  authorizedBranchIds: [BRANCH],
};

async function onPack(packId: string, version: number) {
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, name, jurisdiction, jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
     VALUES ($1, $2, 'EU Desk', 'EU', $3, $4, 'EUR')
     ON CONFLICT (id) DO UPDATE
       SET jurisdiction_pack_id = EXCLUDED.jurisdiction_pack_id,
           jurisdiction_pack_version = EXCLUDED.jurisdiction_pack_version,
           id_threshold = NULL,
           report_threshold = NULL`,
    [ENTITY, TENANT, packId, version],
  );
}

postgres("EU AMLR 2027 pack on PostgreSQL", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await onPack(EU_AMLR_PACK_ID, 2);
  });

  afterAll(async () => {
    /* Audit rows are append-only. Leave them. The entity can go. */
    await pool.query("DELETE FROM ledger_principals WHERE legal_entity_id = $1", [ENTITY]);
    await pool.query("DELETE FROM legal_entities WHERE id = $1", [ENTITY]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [TENANT]);
    await pool.end();
  });

  it("leaves pack-eu-v1 exactly as it was published", async () => {
    const row = (await pool.query(
      `SELECT version, name, regulator, report_name, report_threshold, id_threshold, aggregation_hours
         FROM jurisdiction_packs WHERE pack_id = $1`,
      [EU_V1_PACK_ID],
    )).rows[0];
    expect(Number(row.version)).toBe(1);
    expect(row.name).toBe("Eurozone");
    expect(row.regulator).toBe("AMLD");
    expect(row.report_name).toBe("STR");
    expect(row.report_threshold).toBe("10000.00");
    expect(row.id_threshold).toBe("1000.00");
    expect(Number(row.aggregation_hours)).toBe(24);
    const report = (await pool.query(
      `SELECT report_id FROM jurisdiction_reports WHERE pack_id = $1`,
      [EU_V1_PACK_ID],
    )).rows;
    expect(report.map((item) => item.report_id)).toEqual(["rpt-eu-str"]);
  });

  it("stores the 2027 lines and no large-cash report", async () => {
    const pack = (await pool.query(
      `SELECT version, name, home_currency, regulator, report_name, report_threshold,
              id_threshold, aggregation_hours, retention_years, applies_from::text AS applies_from
         FROM jurisdiction_packs WHERE pack_id = $1`,
      [EU_AMLR_PACK_ID],
    )).rows[0];
    expect(Number(pack.version)).toBe(2);
    expect(String(pack.home_currency).trim()).toBe("EUR");
    expect(pack).toMatchObject({
      name: "EU AMLR 2027",
      regulator: "National FIU",
      report_name: "",
      report_threshold: "0.00",
      id_threshold: "3000.00",
      aggregation_hours: null,
      retention_years: 5,
      applies_from: "2027-07-10",
    });
    const lines = await pool.query(
      `SELECT deal_kind, line_id, threshold, comparator, diligence, cash_only
         FROM jurisdiction_rule_lines
        WHERE pack_id = $1
        ORDER BY line_id, deal_kind`,
      [EU_AMLR_PACK_ID],
    );
    expect(lines.rows).toEqual([
      expect.objectContaining({ deal_kind: "any", line_id: "cash_identify", threshold: "3000.00", comparator: "gte", diligence: "identify", cash_only: true }),
      expect.objectContaining({ deal_kind: "any", line_id: "occasional_cdd", threshold: "10000.00", comparator: "gte", diligence: "cdd", cash_only: false }),
      expect.objectContaining({ deal_kind: "eft", line_id: "transfer_cdd", threshold: "1000.00", comparator: "gte", diligence: "cdd", cash_only: false }),
      expect.objectContaining({ deal_kind: "remittance", line_id: "transfer_cdd", threshold: "1000.00", comparator: "gte", diligence: "cdd", cash_only: false }),
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, deadline_value, deadline_unit, window_kind, format_rules
         FROM jurisdiction_reports WHERE pack_id = $1`,
      [EU_AMLR_PACK_ID],
    );
    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]).toMatchObject({
      code: "STR",
      kind: "suspicious",
      trigger_threshold: null,
      deadline_value: null,
      deadline_unit: null,
      window_kind: "none",
    });
    expect(String(reports.rows[0].format_rules.deadline_label)).toMatch(/5 working days/);
    expect(String(reports.rows[0].format_rules.deadline_label)).toMatch(/no European Union large-cash report/i);
    expect(reports.rows.some((row) => row.kind === "large_cash")).toBe(false);
  });

  it("resolves no reporting line and no aggregation window", async () => {
    const client = await pool.connect();
    try {
      const thresholds = await readDeskThresholds(client, ENTITY);
      expect(thresholds.packId).toBe(EU_AMLR_PACK_ID);
      expect(thresholds.reportThreshold.effective).toBeNull();
      expect(thresholds.aggregationHours.effective).toBeNull();
      expect(thresholds.idThreshold.effective).toBe("3000.00");
      expect(thresholds.retentionYears.effective).toBe(5);
    } finally {
      client.release();
    }
  });

  it("blocks from the regulation's lines and does not block article 80", async () => {
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, ENTITY);
      const post = (amount: string, kind: string, cash: boolean, status: string, purpose = "", source = "") =>
        requireIdentification(client, actor, pack, new Decimal(amount), status, {
          kind,
          cash,
          purpose,
          sourceOfFunds: source,
        });
      await expect(post("2999.99", "exchange", true, "unverified")).resolves.toMatchObject({ rate: "1.000000000000" });
      await expect(post("3000.00", "exchange", true, "unverified")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
      await expect(post("3000.00", "exchange", true, "verified")).resolves.toBeTruthy();
      await expect(post("999.99", "remittance_send", true, "unverified")).resolves.toBeTruthy();
      await expect(post("1000.00", "remittance_send", true, "verified", "", "")).rejects.toThrow(/customer due diligence/);
      await expect(post("1000.00", "remittance_send", true, "verified", "Family support", "Salary")).resolves.toBeTruthy();
      await expect(post("4000.00", "cheque_cashing", true, "unverified")).resolves.toBeTruthy();
      await expect(post("10000.00", "exchange", true, "verified", "Travel", "Savings")).resolves.toBeTruthy();
    } finally {
      client.release();
    }
  });

  it("honours a looser cash identification number and still applies due diligence", async () => {
    await pool.query("UPDATE legal_entities SET id_threshold = 5000 WHERE id = $1", [ENTITY]);
    const client = await pool.connect();
    try {
      const pack = await resolvePack(client, ENTITY);
      await expect(requireIdentification(
        client, actor, pack, new Decimal("4000.00"), "unverified",
        { kind: "exchange", cash: true },
      )).resolves.toBeTruthy();
      await expect(requireIdentification(
        client, actor, pack, new Decimal("10000.00"), "verified",
        { kind: "exchange", cash: true },
      )).rejects.toBeInstanceOf(LedgerError);
    } finally {
      client.release();
    }
    await pool.query("UPDATE legal_entities SET id_threshold = NULL WHERE id = $1", [ENTITY]);
  });

  it("opts a version 1 desk into the 2027 pack and refuses anyone else", async () => {
    await onPack(EU_V1_PACK_ID, 1);
    await pool.query(
      `INSERT INTO ledger_principals
         (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
       VALUES ($1, $2, $3, $4, $5, $6, 'administrator', $7::jsonb)
       ON CONFLICT DO NOTHING`,
      [USER, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, JSON.stringify([BRANCH])],
    );
    const thresholds = new ThresholdService(pool);
    const moved = await thresholds.optInEuAmlr(actor);
    expect(moved.packId).toBe(EU_AMLR_PACK_ID);
    const stamp = await pool.query(
      `SELECT jurisdiction_pack_id, jurisdiction_pack_version FROM legal_entities WHERE id = $1`,
      [ENTITY],
    );
    expect(stamp.rows[0]).toMatchObject({
      jurisdiction_pack_id: EU_AMLR_PACK_ID,
      jurisdiction_pack_version: 2,
    });
    const audit = await pool.query(
      `SELECT action FROM ledger_audit_events
        WHERE legal_entity_id = $1 AND action = 'compliance.pack.opt_in'`,
      [ENTITY],
    );
    expect(audit.rowCount).toBe(1);
    await expect(thresholds.optInEuAmlr(actor)).rejects.toMatchObject({ code: "PACK_OPT_IN_REFUSED" });
  });
});
