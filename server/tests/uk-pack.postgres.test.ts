/* pack-gb-v2 on a real Postgres ledger.

   The published v1 row stays at 1,000 / 10,000 and the report code MLR.
   A following v2 desk identifies an exchange at £12,000 or more and a
   transfer at more than £800, and does not demand purpose and source
   of funds just because there is no cash report. A posted deal keeps
   the pack it was stamped with when the desk opts in. */
import pg from "pg";
import Decimal from "decimal.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { LedgerError, LedgerService, requireIdentification, type LedgerActor } from "../src/ledger/service.js";
import { ObligationService } from "../src/ledger/obligations.js";
import { ThresholdService } from "../src/ledger/threshold-control.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const actor: LedgerActor = {
  userId: "uk-owner",
  tenantId: "tnt-uk-v2",
  legalEntityId: "le-uk-v2",
  branchId: "br-uk-v2",
  workspaceId: "ws-uk-v2",
  tillId: "till-uk",
  role: "administrator",
  authorizedBranchIds: ["br-uk-v2"],
};

let handle: DbHandle;
let pool: pg.Pool;
let ledger: LedgerService;
let obligations: ObligationService;
let thresholds: ThresholdService;

async function reset() {
  await pool.query(
    `TRUNCATE ledger_obligation_events,ledger_obligations,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE`,
  );
  await pool.query(
    `UPDATE legal_entities
        SET jurisdiction_pack_id='pack-gb-v2', jurisdiction_pack_version=2,
            home_currency='GBP', id_threshold=NULL, report_threshold=NULL,
            aggregation_hours=NULL, retention_years=NULL
      WHERE id=$1`,
    [actor.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_principals
       (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1,$2,$3,$4,$5,$6,'administrator',$7)`,
    [actor.userId, actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, actor.tillId, JSON.stringify(actor.authorizedBranchIds)],
  );
  await pool.query(
    `INSERT INTO ledger_customers
       (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
     VALUES
       ('uk-known',$1,$2,$3,$4,'Known Customer','normal','verified'),
       ('uk-walkin',$1,$2,$3,$4,'Walk-in','normal','missing')`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId],
  );
  await pool.query(
    `INSERT INTO ledger_rates (tenant_id,legal_entity_id,branch_id,workspace_id,currency,units_per_cad)
     VALUES ($1,$2,$3,$4,'GBP',1),($1,$2,$3,$4,'USD',1.25)`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId],
  );
  for (const [currency, amount] of [["GBP", "500000.00"], ["USD", "500000.00"]] as const) {
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, actor.tillId, currency, amount],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
       (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at)
     VALUES ('uk-session',$1,$2,$3,$4,$5,1,current_date,'open',$6,now())`,
    [actor.tenantId, actor.legalEntityId, actor.branchId, actor.workspaceId, actor.tillId, actor.userId],
  );
}

const exchange = (key: string, amount: string, purpose = "", source = "") =>
  ledger.post(actor, {
    idempotencyKey: key,
    customerId: "uk-walkin",
    from: "GBP",
    to: "USD",
    inputAmount: amount,
    feeCad: "0.00",
    purpose,
    sourceOfFunds: source,
  });

const send = (key: string, principal: string, fee = "0.00") =>
  obligations.remittanceSend(actor, {
    idempotencyKey: key,
    customerId: "uk-walkin",
    reference: key,
    principalAmount: principal,
    feeAmount: fee,
    payoutCurrency: "USD",
    payoutAmount: "1.00",
    corridor: "US",
    partner: "Test Partner",
    beneficiaryName: "A Beneficiary",
    purpose: "",
    sourceOfFunds: "",
  });

postgres("United Kingdom pack v2", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    ledger = new LedgerService(pool);
    obligations = new ObligationService(pool);
    thresholds = new ThresholdService(pool);
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ($1,'UK Pack') ON CONFLICT DO NOTHING",
      [actor.tenantId],
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'UK Pack','GBP','pack-gb-v2',2)
       ON CONFLICT (id) DO UPDATE
         SET jurisdiction_pack_id='pack-gb-v2', jurisdiction_pack_version=2, home_currency='GBP'`,
      [actor.legalEntityId, actor.tenantId],
    );
    await pool.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'London') ON CONFLICT DO NOTHING",
      [actor.branchId, actor.tenantId, actor.legalEntityId],
    );
  });

  afterAll(async () => {
    /* The ledger rows point at this entity. A disposable database does
       not need them removed, and deleting the entity first fails the
       foreign key. Close the connections and leave the rows. */
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(reset);

  it("leaves pack-gb-v1 untouched and seeds the statutory v2 lines", async () => {
    const v1 = await pool.query(
      `SELECT report_name, report_threshold, id_threshold, retention_years
         FROM jurisdiction_packs WHERE pack_id='pack-gb-v1'`,
    );
    expect(v1.rows[0]).toMatchObject({
      report_name: "MLR",
      report_threshold: "10000.00",
      id_threshold: "1000.00",
      retention_years: 5,
    });
    const oldReport = await pool.query(
      "SELECT code, name, kind FROM jurisdiction_reports WHERE report_id='rpt-gb-mlr'",
    );
    expect(oldReport.rows[0]).toMatchObject({
      code: "MLR",
      name: "Money Laundering Report",
      kind: "suspicious",
    });

    const v2 = await pool.query(
      `SELECT report_name, report_threshold, id_threshold, retention_years, aggregation_hours, regulator
         FROM jurisdiction_packs WHERE pack_id='pack-gb-v2'`,
    );
    expect(v2.rows[0]).toMatchObject({
      report_name: "SAR",
      report_threshold: "0.00",
      id_threshold: "12000.00",
      retention_years: 5,
      aggregation_hours: 24,
      regulator: "HMRC",
    });
    const lines = await pool.query(
      `SELECT deal_kind, threshold, comparator, diligence, currency
         FROM jurisdiction_id_thresholds WHERE pack_id='pack-gb-v2' ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "800.00", comparator: "gt", diligence: "cdd", currency: "GBP" },
      { deal_kind: "fx", threshold: "12000.00", comparator: "gte", diligence: "cdd", currency: "GBP" },
      { deal_kind: "remittance", threshold: "800.00", comparator: "gt", diligence: "cdd", currency: "GBP" },
      { deal_kind: "virtual_currency", threshold: "12000.00", comparator: "gte", diligence: "cdd", currency: "GBP" },
    ]);
    const sar = await pool.query(
      `SELECT code, name, kind, trigger_threshold, window_kind, filing_format, format_rules
         FROM jurisdiction_reports WHERE pack_id='pack-gb-v2'`,
    );
    expect(sar.rows).toHaveLength(1);
    expect(sar.rows[0]).toMatchObject({
      code: "SAR",
      name: "Suspicious Activity Report",
      kind: "suspicious",
      trigger_threshold: null,
      window_kind: "none",
      filing_format: "NCA SAR Online",
    });
    expect(sar.rows[0].format_rules.recipient).toBe("NCA UKFIU");
    const large = await pool.query(
      "SELECT 1 FROM jurisdiction_reports WHERE pack_id='pack-gb-v2' AND kind='large_cash'",
    );
    expect(large.rowCount).toBe(0);
  });

  it("posts an exchange under £12,000 without identification or purpose, and refuses £12,000", async () => {
    const posted = await exchange("fx-under", "11999.99");
    expect(posted.transactionId).toBeTruthy();
    await expect(exchange("fx-at", "12000.00")).rejects.toMatchObject({
      code: "COMPLIANCE_BLOCKED",
    });
    const stamps = await pool.query(
      "SELECT jurisdiction_pack_id, jurisdiction_pack_version FROM ledger_transactions",
    );
    expect(stamps.rows).toEqual([
      { jurisdiction_pack_id: "pack-gb-v2", jurisdiction_pack_version: 2 },
    ]);
  });

  it("posts a transfer of £800.00 and refuses £800.01, including the fee", async () => {
    await send("tr-at", "800.00");
    await expect(send("tr-over", "800.01")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(send("tr-fee", "799.99", "0.02")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    expect((await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0].count).toBe("1");
  });

  it("uses the transfer line for a bill payment and the exchange line for virtual currency", async () => {
    await obligations.billPayment(actor, {
      idempotencyKey: "bill-at",
      customerId: "uk-walkin",
      reference: "bill-at",
      billAmount: "800.00",
      feeAmount: "0.00",
      biller: "A Biller",
      accountRef: "100",
      purpose: "",
      sourceOfFunds: "",
    });
    await expect(obligations.billPayment(actor, {
      idempotencyKey: "bill-over",
      customerId: "uk-walkin",
      reference: "bill-over",
      billAmount: "800.01",
      feeAmount: "0.00",
      biller: "A Biller",
      accountRef: "100",
      purpose: "",
      sourceOfFunds: "",
    })).rejects.toBeInstanceOf(LedgerError);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const pack = await resolvePack(client, actor.legalEntityId);
      await expect(requireIdentification(
        client, actor, pack, new Decimal("11999.99"), "missing",
        { kind: "virtual_currency", cash: true },
      )).resolves.toBeTruthy();
      await expect(requireIdentification(
        client, actor, pack, new Decimal("12000.00"), "missing",
        { kind: "virtual_currency", cash: true },
      )).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("keeps v1 identifying at 1,000 until the desk opts in, and does not restamp the deal", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET jurisdiction_pack_id='pack-gb-v1', jurisdiction_pack_version=1
        WHERE id=$1`,
      [actor.legalEntityId],
    );
    await exchange("v1-under", "999.99", "Travel", "Salary");
    await expect(exchange("v1-at", "1000.00", "Travel", "Salary")).rejects.toMatchObject({
      code: "COMPLIANCE_BLOCKED",
    });

    const moved = await thresholds.adoptUnitedKingdomV2(actor);
    expect(moved.packId).toBe("pack-gb-v2");
    expect(moved.idThreshold.deskChoice).toBeNull();
    expect(moved.idThreshold.effective).toBe("12000.00");
    expect(moved.reportThreshold.effective).toBeNull();
    expect(moved.transferDueDiligence).toEqual({ amount: "800.00", comparator: "gt" });

    const again = await thresholds.adoptUnitedKingdomV2(actor);
    expect(again.packId).toBe("pack-gb-v2");

    const stamp = await pool.query(
      "SELECT jurisdiction_pack_id, jurisdiction_pack_version FROM ledger_transactions",
    );
    expect(stamp.rows).toEqual([
      { jurisdiction_pack_id: "pack-gb-v1", jurisdiction_pack_version: 1 },
    ]);
  });

  it("refuses to move a desk that is not on the United Kingdom v1 pack", async () => {
    await pool.query(
      "UPDATE legal_entities SET jurisdiction_pack_id='pack-ca-v1', jurisdiction_pack_version=1 WHERE id=$1",
      [actor.legalEntityId],
    );
    await expect(thresholds.adoptUnitedKingdomV2(actor)).rejects.toMatchObject({
      code: "JURISDICTION_PACK_CONFLICT",
    });
    const still = await pool.query(
      "SELECT jurisdiction_pack_id FROM legal_entities WHERE id=$1",
      [actor.legalEntityId],
    );
    expect(still.rows[0].jurisdiction_pack_id).toBe("pack-ca-v1");
  });

  it("lets a desk number of 1,000 tighten the exchange and not the transfer", async () => {
    await pool.query("UPDATE legal_entities SET id_threshold='1000.00' WHERE id=$1", [actor.legalEntityId]);
    await expect(exchange("desk-fx", "1000.00", "Travel", "Salary")).rejects.toMatchObject({
      code: "COMPLIANCE_BLOCKED",
    });
    await exchange("desk-fx-under", "999.99", "Travel", "Salary");
    await send("desk-tr", "800.00");
    await expect(send("desk-tr-over", "800.01")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });

  it("lets a desk number of 20,000 loosen only the exchange", async () => {
    await pool.query("UPDATE legal_entities SET id_threshold='20000.00' WHERE id=$1", [actor.legalEntityId]);
    await exchange("loose-under", "19999.99");
    await expect(exchange("loose-at", "20000.00")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await expect(send("loose-tr", "800.01")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
  });

  it("asks for purpose and source only when the desk has set its own reporting line", async () => {
    await exchange("no-report", "500.00");
    await pool.query("UPDATE legal_entities SET report_threshold='400.00' WHERE id=$1", [actor.legalEntityId]);
    await expect(exchange("desk-report", "400.00")).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
    await exchange("desk-report-said", "400.00", "Travel", "Salary");
  });
});
