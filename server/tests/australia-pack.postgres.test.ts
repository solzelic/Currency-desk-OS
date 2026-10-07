/* pack-au-v2 against PostgreSQL.

   Proves the published v1 row is untouched, the v2 catalogue matches
   the Act, the posting gate follows the per-deal lines, and opt-in
   does not rewrite a deal that was already stamped. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { LedgerError, requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { ThresholdService } from "../src/ledger/threshold-control.js";
import { readDeskThresholds } from "../src/ledger/thresholds.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let handle: DbHandle;

const TENANT = "tnt-au-v2";
const ENTITY = "le-au-v2";
const ACTOR: LedgerActor = {
  userId: "user-au-v2",
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: "br-au",
  workspaceId: "ws-au",
  tillId: "till-au",
  role: "administrator",
  authorizedBranchIds: ["br-au"],
};

async function withClient<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

async function pointAt(packId: string, version: number) {
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'Australia Desk', 'AU', 'AUD', $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET jurisdiction_pack_id = EXCLUDED.jurisdiction_pack_id,
           jurisdiction_pack_version = EXCLUDED.jurisdiction_pack_version,
           home_currency = 'AUD'`,
    [ENTITY, TENANT, packId, version],
  );
  await pool.query(
    `UPDATE legal_entities
        SET report_threshold = NULL, id_threshold = NULL,
            aggregation_hours = NULL, retention_years = NULL
      WHERE id = $1`,
    [ENTITY],
  );
}

async function judge(kind: string, amount: string, idStatus = "unverified") {
  return withClient(async (client) => {
    const pack = await resolvePack(client, ENTITY);
    try {
      await requireIdentification(
        client,
        ACTOR,
        pack,
        new Decimal(amount),
        idStatus,
        { kind, cash: true },
      );
      return "posted";
    } catch (error) {
      if (error instanceof LedgerError) return error.code;
      throw error;
    }
  });
}

postgres("Australia pack v2", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    await pointAt("pack-au-v2", 2);
    await pool.query(
      `INSERT INTO ledger_principals
         (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id, role, authorized_branch_ids)
       VALUES ($1, $2, $3, $4, $5, $6, 'administrator', $7::jsonb)
       ON CONFLICT (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id) DO UPDATE
         SET role = 'administrator', authorized_branch_ids = EXCLUDED.authorized_branch_ids`,
      [ACTOR.userId, TENANT, ENTITY, ACTOR.branchId, ACTOR.workspaceId, ACTOR.tillId, JSON.stringify(ACTOR.authorizedBranchIds)],
    );
  });

  afterAll(async () => {
    /* Transactions and audit rows are append-only. A fresh database is
       the cleanup, same as the other ledger suites. */
    await pool.query("DELETE FROM ledger_principals WHERE user_id = $1", [ACTOR.userId]);
    await pool.query("DELETE FROM legal_entities WHERE id = $1", [ENTITY]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [TENANT]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("leaves pack-au-v1 exactly as it was published", async () => {
    const pack = await pool.query(
      `SELECT version, id_threshold, retention_years
         FROM jurisdiction_packs WHERE pack_id = 'pack-au-v1'`,
    );
    expect(pack.rows[0].version).toBe(1);
    expect(pack.rows[0].id_threshold).toBe("1000.00");
    expect(pack.rows[0].retention_years).toBe(7);
    const ttr = await pool.query(
      `SELECT direction, aggregation_hours
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-au-v1' AND code = 'TTR'`,
    );
    expect(ttr.rows[0].direction).toBe("in");
    expect(Number(ttr.rows[0].aggregation_hours)).toBe(24);
    const ivts = await pool.query(
      `SELECT count(*)::int AS n FROM jurisdiction_reports
        WHERE pack_id = 'pack-au-v1' AND code = 'IVTS'`,
    );
    expect(ivts.rows[0].n).toBe(0);
  });

  it("stores the v2 catalogue the Act describes", async () => {
    const lines = await pool.query(
      `SELECT deal_kind, threshold, comparator, diligence
         FROM jurisdiction_id_thresholds
        WHERE pack_id = 'pack-au-v2'
        ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "0.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "fx", threshold: "1000.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "remittance", threshold: "0.00", comparator: "gte", diligence: "cdd" },
      { deal_kind: "virtual_currency", threshold: "0.00", comparator: "gte", diligence: "cdd" },
    ]);
    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, deadline_value, deadline_unit,
              window_kind, direction, cash_only
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-au-v2'
        ORDER BY code`,
    );
    const byCode = Object.fromEntries(reports.rows.map((row) => [row.code, row]));
    expect(byCode.TTR).toMatchObject({
      kind: "large_cash",
      trigger_threshold: "10000.00",
      deadline_value: 10,
      deadline_unit: "business_days",
      window_kind: "none",
      direction: "both",
      cash_only: true,
    });
    expect(byCode.SMR).toMatchObject({
      deadline_value: 3,
      deadline_unit: "business_days",
    });
    expect(byCode["SMR-TF"]).toMatchObject({
      deadline_value: 24,
      deadline_unit: "hours",
    });
    expect(byCode.IVTS).toMatchObject({
      kind: "wire",
      trigger_threshold: null,
      deadline_value: 10,
      deadline_unit: "business_days",
      direction: "both",
    });
    expect(byCode.COMPLIANCE.deadline_value).toBeNull();
    const note = await pool.query(
      `SELECT format_rules->>'note' AS note
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-au-v2' AND code = 'COMPLIANCE'`,
    );
    expect(note.rows[0].note).toMatch(/30 September 2027/);
    expect(note.rows[0].note).toMatch(/does not prepare/);
    const kept = await pool.query(
      `SELECT retention_years FROM jurisdiction_packs WHERE pack_id = 'pack-au-v2'`,
    );
    expect(kept.rows[0].retention_years).toBe(7);
  });

  it("identifies an exchange from 1000 AUD and every remittance", async () => {
    await pointAt("pack-au-v2", 2);
    expect(await judge("exchange", "999.99")).toBe("posted");
    expect(await judge("exchange", "1000.00")).toBe("COMPLIANCE_BLOCKED");
    expect(await judge("exchange", "1000.00", "verified")).toBe("posted");
    expect(await judge("remittance_send", "0.01")).toBe("COMPLIANCE_BLOCKED");
    expect(await judge("remittance_receive", "1.00", "verified")).toBe("posted");
    expect(await judge("bill_payment", "1.00")).toBe("COMPLIANCE_BLOCKED");
    expect(await judge("money_order", "999.99")).toBe("posted");
    expect(await judge("money_order", "1000.00")).toBe("COMPLIANCE_BLOCKED");

    const shown = await withClient((client) => readDeskThresholds(client, ENTITY));
    expect(shown.remittanceIdThreshold.effective).toBe("0.00");
    expect(shown.retentionYears.effective).toBe(7);
  });

  it("lets a looser desk number move the exchange line and not the remittance line", async () => {
    await pointAt("pack-au-v2", 2);
    await pool.query(
      "UPDATE legal_entities SET id_threshold = 5000 WHERE id = $1",
      [ENTITY],
    );
    expect(await judge("exchange", "4999.99")).toBe("posted");
    expect(await judge("exchange", "5000.00")).toBe("COMPLIANCE_BLOCKED");
    expect(await judge("remittance_send", "1.00")).toBe("COMPLIANCE_BLOCKED");
    await pool.query("UPDATE legal_entities SET id_threshold = NULL WHERE id = $1", [ENTITY]);
  });

  it("still uses the single 1000 line for a desk that has not opted in", async () => {
    await pointAt("pack-au-v1", 1);
    expect(await judge("exchange", "999.99")).toBe("posted");
    expect(await judge("exchange", "1000.00")).toBe("COMPLIANCE_BLOCKED");
    expect(await judge("remittance_send", "1.00")).toBe("posted");
    await pointAt("pack-au-v2", 2);
  });

  it("opts in without rewriting a posted deal or the desk's own number", async () => {
    await pointAt("pack-au-v1", 1);
    await pool.query(
      "UPDATE legal_entities SET id_threshold = 2500 WHERE id = $1",
      [ENTITY],
    );
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
          workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
          input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
          source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
          jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
       VALUES
         ('tx-au-v1', 'ref-au-v1', $1, $2, $3, $4, $5, 'cust-au', $6,
          'AUD', 'USD', 20.00, 12.00, 1.5, 0, 0, 'travel', 'salary', now(),
          'exchange', 'cash', 'cash', 'pack-au-v1', 1, 'AUD')`,
      [TENANT, ENTITY, ACTOR.branchId, ACTOR.workspaceId, ACTOR.tillId, ACTOR.userId],
    );
    const service = new ThresholdService(pool);
    const after = await service.optInAustraliaV2(ACTOR);
    expect(after.packId).toBe("pack-au-v2");
    expect(after.idThreshold.deskChoice).toBe("2500.00");
    const stamp = await pool.query(
      `SELECT jurisdiction_pack_id, jurisdiction_pack_version
         FROM ledger_transactions WHERE transaction_id = 'tx-au-v1'`,
    );
    expect(stamp.rows[0]).toEqual({
      jurisdiction_pack_id: "pack-au-v1",
      jurisdiction_pack_version: 1,
    });
    const version = await pool.query(
      `SELECT jurisdiction_pack_version FROM legal_entities WHERE id = $1`,
      [ENTITY],
    );
    expect(version.rows[0].jurisdiction_pack_version).toBe(2);
    const audit = await pool.query(
      `SELECT action FROM ledger_audit_events
        WHERE legal_entity_id = $1 AND action = 'compliance.pack.opt_in'`,
      [ENTITY],
    );
    expect(audit.rowCount).toBe(1);
    await expect(service.optInAustraliaV2(ACTOR)).rejects.toMatchObject({
      code: "PACK_OPT_IN_REFUSED",
    });
  });
});
