/* pack-ae-v2 against Postgres.

   pack-ae-v1 stays the published row: STR at 55,000 is still stored
   there, and this file does not treat that as the rule for a v2 desk.
   v2 has no cash report. Foreign exchange identifies at 3,500 or more.
   One foreign exchange of 35,000 or more needs purpose and source of
   funds. A money transfer needs both at any amount. A desk cannot
   raise the 3,500 floor. Opting in does not rewrite a stamp.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { ObligationService } from "../src/ledger/obligations.js";
import { ThresholdService } from "../src/ledger/threshold-control.js";
import {
  LedgerService,
  requireIdentification,
  type FrozenQuote,
  type LedgerActor,
} from "../src/ledger/service.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import Decimal from "decimal.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const TENANT = "tnt-ae-v2";
const ENTITY = "le-ae-v2";
const BRANCH = "br-ae-v2";
const WORKSPACE = "ws-ae-v2";
const TILL = "till-ae-v2";

const actor: LedgerActor = {
  userId: "ae-v2-owner",
  tenantId: TENANT,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  workspaceId: WORKSPACE,
  tillId: TILL,
  role: "administrator",
  authorizedBranchIds: [BRANCH],
};

let pool: pg.Pool;
let handle: DbHandle;
let ledger: LedgerService;
let obligations: ObligationService;
let thresholds: ThresholdService;
let deal = 0;

async function reset(packId: string, version: number) {
  await pool.query(
    `TRUNCATE ledger_vault_balances, ledger_vault_movements,
      ledger_cost_lot_consumption, ledger_cost_lots, ledger_cost_events,
      quote_events, quote_overrides, quotes,
      ledger_operational_cash_movements, ledger_till_counts,
      ledger_till_count_batches, ledger_till_sessions, ledger_audit_events,
      ledger_reversal_entries, ledger_reversals, ledger_till_movements,
      ledger_journal_entries, ledger_transactions, ledger_idempotency,
      ledger_obligations, ledger_till_balances, ledger_rates,
      ledger_customers, ledger_principals CASCADE`,
  );
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, 'UAE v2') ON CONFLICT DO NOTHING",
    [TENANT],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, name, jurisdiction, home_currency,
        jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'UAE desk', 'AE', 'AED', $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET jurisdiction_pack_id = EXCLUDED.jurisdiction_pack_id,
           jurisdiction_pack_version = EXCLUDED.jurisdiction_pack_version,
           home_currency = 'AED',
           report_threshold = NULL,
           id_threshold = NULL`,
    [ENTITY, TENANT, packId, version],
  );
  await pool.query(
    `INSERT INTO ledger_principals
       (user_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        role, authorized_branch_ids)
     VALUES ($1, $2, $3, $4, $5, $6, 'administrator', $7)`,
    [actor.userId, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, JSON.stringify([BRANCH])],
  );
  await pool.query(
    `INSERT INTO ledger_customers
       (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id,
        name, risk, id_status)
     VALUES
       ('cust-ae-new', $1, $2, $3, $4, 'Walk-in', 'Normal', 'unverified'),
       ('cust-ae-known', $1, $2, $3, $4, 'Regular', 'Normal', 'verified')`,
    [TENANT, ENTITY, BRANCH, WORKSPACE],
  );
  await pool.query(
    `INSERT INTO ledger_rates
       (tenant_id, legal_entity_id, branch_id, workspace_id, currency, units_per_cad)
     VALUES
       ($1, $2, $3, $4, 'AED', 1),
       ($1, $2, $3, $4, 'USD', 0.27)`,
    [TENANT, ENTITY, BRANCH, WORKSPACE],
  );
  for (const [currency, amount] of [
    ["AED", "500000.00"],
    ["USD", "500000.00"],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_till_balances
         (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [TENANT, ENTITY, BRANCH, WORKSPACE, TILL, currency, amount],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
       (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
        session_number, business_date, status, opened_by, opened_at)
     VALUES ('session-ae-v2', $1, $2, $3, $4, $5, 1, current_date, 'open', $6, now())`,
    [TENANT, ENTITY, BRANCH, WORKSPACE, TILL, actor.userId],
  );
}

const sell = (
  amount: string,
  customerId = "cust-ae-new",
  extra: { purpose?: string; sourceOfFunds?: string } = {},
) =>
  ledger.post(actor, {
    idempotencyKey: `ae-${++deal}`,
    customerId,
    from: "AED",
    to: "USD",
    inputAmount: amount,
    feeCad: "0.00",
    purpose: extra.purpose ?? "Personal travel",
    sourceOfFunds: extra.sourceOfFunds ?? "Salary",
  });

const blocked = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });

postgres("United Arab Emirates pack version 2", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    ledger = new LedgerService(pool);
    obligations = new ObligationService(pool);
    thresholds = new ThresholdService(pool);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM legal_entities WHERE id = $1", [ENTITY]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [TENANT]);
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => reset("pack-ae-v2", 2));

  it("leaves pack-ae-v1 alone and does not invent a cash report on v2", async () => {
    const v1 = await pool.query(
      `SELECT report_threshold::text AS report_threshold, id_threshold::text AS id_threshold,
              retention_years
         FROM jurisdiction_packs WHERE pack_id = 'pack-ae-v1'`,
    );
    expect(v1.rows[0]).toMatchObject({
      report_threshold: "55000.00",
      id_threshold: "3500.00",
      retention_years: 5,
    });

    const v2 = await pool.query(
      `SELECT report_threshold::text AS report_threshold, id_threshold::text AS id_threshold,
              aggregation_hours, retention_years, kind
         FROM jurisdiction_packs WHERE pack_id = 'pack-ae-v2'`,
    );
    expect(v2.rows[0]).toMatchObject({
      report_threshold: "0.00",
      id_threshold: "3500.00",
      aggregation_hours: 24,
      retention_years: 5,
      kind: "country",
    });

    const lines = await pool.query(
      `SELECT deal_kind, threshold::text AS threshold, diligence
         FROM jurisdiction_id_thresholds
        WHERE pack_id = 'pack-ae-v2'
        ORDER BY deal_kind`,
    );
    expect(lines.rows).toEqual([
      { deal_kind: "eft", threshold: "0.00", diligence: "cdd" },
      { deal_kind: "fx", threshold: "3500.00", diligence: "identify" },
      { deal_kind: "remittance", threshold: "0.00", diligence: "cdd" },
      { deal_kind: "virtual_currency", threshold: null, diligence: "identify" },
    ]);

    const reports = await pool.query(
      `SELECT code, kind, trigger_threshold, deadline_unit, deadline_value, window_kind, filing_format
         FROM jurisdiction_reports
        WHERE pack_id = 'pack-ae-v2'
        ORDER BY code`,
    );
    expect(reports.rows.map((row) => row.kind)).not.toContain("large_cash");
    expect(reports.rows).toEqual([
      expect.objectContaining({
        code: "FFR",
        kind: "other",
        trigger_threshold: null,
        deadline_unit: "business_days",
        deadline_value: 2,
        window_kind: "none",
        filing_format: "goAML",
      }),
      expect.objectContaining({
        code: "PMNR",
        kind: "other",
        deadline_unit: null,
        window_kind: "none",
        filing_format: "goAML",
      }),
      expect.objectContaining({
        code: "SAR",
        kind: "suspicious",
        deadline_unit: "immediately",
        window_kind: "none",
        filing_format: "goAML",
      }),
      expect.objectContaining({
        code: "STR",
        kind: "suspicious",
        deadline_unit: "immediately",
        window_kind: "none",
        filing_format: "goAML",
      }),
    ]);
  });

  it("identifies an unverified foreign exchange at 3,500 and not at 3,499.99", async () => {
    await expect(sell("3499.99")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    await blocked(sell("3500.00"));
  });

  it("does not let a stored 10,000 raise the 3,500 floor, and does let 1,000 tighten it", async () => {
    await pool.query(
      "UPDATE legal_entities SET id_threshold = 10000 WHERE id = $1",
      [ENTITY],
    );
    await expect(sell("3499.99")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    await blocked(sell("3500.00"));

    await expect(
      thresholds.set(actor, { idThreshold: "3500.00" }),
    ).rejects.toMatchObject({ code: "IDENTIFICATION_FLOOR" });
    await expect(
      thresholds.set(actor, { idThreshold: "10000" }),
    ).rejects.toMatchObject({ code: "IDENTIFICATION_FLOOR" });

    const saved = await thresholds.set(actor, { idThreshold: "1000.00" });
    expect(saved.idThreshold.effective).toBe("1000.00");
    await expect(sell("999.99")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
    await blocked(sell("1000.00"));
  });

  it("asks a verified customer for purpose and source of funds at 35,000, not at 34,999.99", async () => {
    await expect(
      sell("34999.99", "cust-ae-known", { purpose: "", sourceOfFunds: "" }),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
    await blocked(
      sell("35000.00", "cust-ae-known", { purpose: "", sourceOfFunds: "" }),
    );
    await expect(
      sell("35000.00", "cust-ae-known", {
        purpose: "Travel",
        sourceOfFunds: "Salary",
      }),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
  });

  it("honours a reporting number the desk typed, below the 35,000 line", async () => {
    await thresholds.set(actor, { reportThreshold: "10000.00" });
    await blocked(
      sell("10000.00", "cust-ae-known", { purpose: "", sourceOfFunds: "" }),
    );
    await expect(
      sell("9999.99", "cust-ae-known", { purpose: "", sourceOfFunds: "" }),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
  });

  it("requires identification and purpose on a money transfer of any amount", async () => {
    const send = (customerId: string, purpose: string, source: string) =>
      obligations.remittanceSend(actor, {
        idempotencyKey: `ae-remit-${++deal}`,
        customerId,
        reference: `AE-${deal}`,
        principalAmount: "1.00",
        feeAmount: "0.00",
        payoutCurrency: "USD",
        payoutAmount: "1.00",
        corridor: "US",
        partner: "UAE Seam Partner",
        beneficiaryName: "A Beneficiary",
        purpose,
        sourceOfFunds: source,
      });

    await blocked(send("cust-ae-new", "Family support", "Salary"));
    await blocked(send("cust-ae-known", "", ""));
    await expect(send("cust-ae-known", "Family support", "Salary")).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it("identifies a cheque at the foreign-exchange line and does not add a purpose rule", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const pack = await resolvePack(client, ENTITY);
      await expect(
        requireIdentification(
          client,
          actor,
          pack,
          new Decimal("3499.99"),
          "unverified",
          { kind: "cheque_cashing", cash: true },
        ),
      ).resolves.toBeTruthy();
      await expect(
        requireIdentification(
          client,
          actor,
          pack,
          new Decimal("3500.00"),
          "unverified",
          { kind: "cheque_cashing", cash: true },
        ),
      ).rejects.toMatchObject({ code: "COMPLIANCE_BLOCKED" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("checks purpose on a frozen quote, which is the path the till posts", async () => {
    const quote = async (
      id: string,
      input: string,
      fromMid: string,
      purpose: string,
      source: string,
    ) => {
      const output = "3400.00";
      await pool.query(
        `INSERT INTO quotes
           (quote_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
            customer_id, created_by, direction, from_currency, to_currency,
            input_amount, output_amount, market_mid, customer_rate, buy_or_sell_side,
            fee_cad, spread_cad, rate_board_publication_id, market_snapshot_id,
            rate_source_type, status, expires_at, created_at, from_mid, to_mid)
         VALUES
           ($1, $2, $3, $4, $5, $6,
            'cust-ae-known', $7, 'customer_sell_foreign', 'USD', 'AED',
            $8, $9, $10, $10, 'we_buy',
            0, 0, 'board-ae', NULL,
            'manual', 'active', now() + interval '10 minutes', now(), $10, 1)`,
        [id, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, actor.userId, input, output, fromMid],
      );
      const frozen: FrozenQuote = {
        quoteId: id,
        customerId: "cust-ae-known",
        from: "USD",
        to: "AED",
        inputAmount: input,
        outputAmount: output,
        marketMid: fromMid,
        fromMid,
        toMid: "1.000000000000",
        customerRate: fromMid,
        feeCad: "0.00",
        spreadCad: "0.00",
        rateBoardPublicationId: "board-ae",
        marketSnapshotId: null,
        rateSourceType: "manual",
        quoteOverrideId: null,
        purpose,
        sourceOfFunds: source,
      };
      return ledger.postFrozenQuote(actor, frozen, id);
    };

    /* 10,000 USD at 3.499999 AED per USD is 34,999.99 AED. */
    await expect(
      quote("q-ae-under", "10000.00", "3.499999000000", "", ""),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
    await blocked(quote("q-ae-over", "10000.00", "3.500000000000", "", ""));
    await expect(
      quote("q-ae-over-ok", "10000.00", "3.500000000000", "Travel", "Salary"),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
  });

  it("keeps a v1 stamp when the desk opts in", async () => {
    await reset("pack-ae-v1", 1);
    const posted = await sell("1000.00", "cust-ae-new");
    const before = await pool.query(
      `SELECT jurisdiction_pack_id, jurisdiction_pack_version
         FROM ledger_transactions WHERE transaction_id = $1`,
      [posted.transactionId],
    );
    expect(before.rows[0]).toMatchObject({
      jurisdiction_pack_id: "pack-ae-v1",
      jurisdiction_pack_version: 1,
    });

    const moved = await thresholds.adoptUnitedArabEmiratesV2(actor);
    expect(moved.packId).toBe("pack-ae-v2");
    const again = await thresholds.adoptUnitedArabEmiratesV2(actor);
    expect(again.packId).toBe("pack-ae-v2");

    const still = await pool.query(
      `SELECT jurisdiction_pack_id, jurisdiction_pack_version
         FROM ledger_transactions WHERE transaction_id = $1`,
      [posted.transactionId],
    );
    expect(still.rows).toEqual(before.rows);

    const next = await sell("1000.00", "cust-ae-known");
    const stamped = await pool.query(
      `SELECT jurisdiction_pack_id FROM ledger_transactions WHERE transaction_id = $1`,
      [next.transactionId],
    );
    expect(stamped.rows[0].jurisdiction_pack_id).toBe("pack-ae-v2");
  });

  it("refuses to move a desk that is not on the UAE pack", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET jurisdiction_pack_id = 'pack-ca-v1', jurisdiction_pack_version = 1
        WHERE id = $1`,
      [ENTITY],
    );
    await expect(thresholds.adoptUnitedArabEmiratesV2(actor)).rejects.toMatchObject({
      code: "JURISDICTION_PACK_CONFLICT",
    });
  });
});
