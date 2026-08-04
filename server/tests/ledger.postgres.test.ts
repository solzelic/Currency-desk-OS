import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { LedgerError, LedgerService, type LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let handle: DbHandle;
let pool: pg.Pool;
let service: LedgerService;
const teller: LedgerActor = {
  userId: "teller-1", tenantId: "tenant-1", legalEntityId: "le-1", branchId: "branch-1",
  workspaceId: "workspace-1", tillId: "till-1", role: "teller", authorizedBranchIds: ["branch-1"],
};
const supervisor: LedgerActor = { ...teller, userId: "supervisor-1", role: "supervisor" };
const request = {
  idempotencyKey: "post-1", customerId: "customer-1", from: "CAD" as const, to: "USD" as const,
  inputAmount: "1000.00", feeCad: "4.00", purpose: "Travel", sourceOfFunds: "Cash",
};

async function reset() {
  await pool.query("TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_events,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE");
  await pool.query("INSERT INTO ledger_principals VALUES ('teller-1','tenant-1','le-1','branch-1','workspace-1','till-1','teller','[\"branch-1\"]'),('supervisor-1','tenant-1','le-1','branch-1','workspace-1','till-1','supervisor','[\"branch-1\"]')");
  await pool.query("INSERT INTO ledger_customers VALUES ('customer-1','tenant-1','le-1','branch-1','workspace-1','Customer','Normal','verified')");
  await pool.query("INSERT INTO ledger_rates VALUES ('tenant-1','le-1','branch-1','workspace-1','CAD',1),('tenant-1','le-1','branch-1','workspace-1','USD',0.731),('tenant-1','le-1','branch-1','workspace-1','EUR',0.676),('tenant-1','le-1','branch-1','workspace-1','GBP',0.581)");
  for (const [currency, value] of [["CAD", 25000], ["USD", 12000], ["EUR", 7000], ["GBP", 3500]]) {
    await pool.query("INSERT INTO ledger_till_balances VALUES ('tenant-1','le-1','branch-1','workspace-1','till-1',$1,$2)", [currency, value]);
  }
  await pool.query("INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at) VALUES ('session-1','tenant-1','le-1','branch-1','workspace-1','till-1',1,current_date,'open','teller-1',now())");
}

postgres("real PostgreSQL ledger posting", () => {
  beforeAll(async () => {
    /* The whole schema, not three hand-picked files. Posting now asks the
       legal entity's jurisdiction pack what currency the book is kept in
       and whether a pair may be traded, so the pack tables have to exist
       here rather than only in whichever suite happened to run first. */
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    service = new LedgerService(pool);
    /* A desk whose jurisdiction genuinely forbids foreign-to-foreign deals.
       This file's entity is deliberately one of those, so the refusal it
       asserts is a rule somebody configured rather than a constant in the
       code. */
    await pool.query(
      `INSERT INTO jurisdiction_packs
         (pack_id,jurisdiction,version,name,home_currency,regulator,
          report_name,report_threshold,id_threshold,report_currency,
          allow_cross_currency)
       VALUES ('pack-nocross-v1','ZZ',1,'No Cross','CAD','TESTREG',
               'NIL',10000,3000,'CAD',false)
       ON CONFLICT (pack_id) DO NOTHING`,
    );
    await pool.query(
      "INSERT INTO tenants (id,name) VALUES ('tenant-1','Ledger tests') ON CONFLICT DO NOTHING",
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ('le-1','tenant-1','Ledger tests','CAD','pack-nocross-v1',1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-nocross-v1'`,
    );
  });
  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });
  beforeEach(reset);

  it("persists an atomic transaction, balanced journal, separate CAD fee and audit", async () => {
    const posted = await service.post(teller, request);
    expect((await pool.query("SELECT * FROM ledger_transactions")).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM ledger_journal_entries WHERE transaction_id=$1", [posted.transactionId])).rowCount).toBe(5);
    expect((await pool.query("SELECT * FROM ledger_till_movements WHERE transaction_id=$1", [posted.transactionId])).rowCount).toBe(3);
    expect((await pool.query("SELECT * FROM ledger_audit_events WHERE target_id=$1", [posted.transactionId])).rowCount).toBe(1);
    const entries = await pool.query("SELECT account_code,side,amount_cad FROM ledger_journal_entries WHERE transaction_id=$1", [posted.transactionId]);
    expect(entries.rows).toContainEqual({ account_code: "till:CAD", side: "debit", amount_cad: "4.00" });
    const totals = await pool.query("SELECT side,sum(amount_cad) amount FROM ledger_journal_entries GROUP BY side");
    expect(totals.rows.find((r) => r.side === "debit").amount).toBe(totals.rows.find((r) => r.side === "credit").amount);
  });

  it.each([
    ["CAD to foreign, zero fee", { from: "CAD" as const, to: "USD" as const, feeCad: "0.00" }],
    ["CAD to foreign, fee", { from: "CAD" as const, to: "USD" as const, feeCad: "4.00" }],
    ["foreign to CAD, zero fee", { from: "USD" as const, to: "CAD" as const, feeCad: "0.00" }],
    ["foreign to CAD, fee", { from: "USD" as const, to: "CAD" as const, feeCad: "4.00" }],
  ])("balances %s", async (_name, values) => {
    const posted = await service.post(teller, { ...request, ...values, idempotencyKey: `pair-${_name}` });
    const totals = await pool.query("SELECT side,sum(amount_cad) amount FROM ledger_journal_entries WHERE transaction_id=$1 GROUP BY side", [posted.transactionId]);
    expect(totals.rows.find((r) => r.side === "debit").amount).toBe(totals.rows.find((r) => r.side === "credit").amount);
    const feeLine = await pool.query("SELECT amount_cad FROM ledger_journal_entries WHERE transaction_id=$1 AND account_code='till:CAD' AND side='debit' ORDER BY entry_id DESC LIMIT 1", [posted.transactionId]);
    expect(feeLine.rows[0].amount_cad).toBe(values.feeCad);
  });

  it("deduplicates retries and concurrent posts", async () => {
    const [a, b] = await Promise.all([service.post(teller, request), service.post(teller, request)]);
    expect(a.transactionId).toBe(b.transactionId);
    expect((await pool.query("SELECT * FROM ledger_transactions")).rowCount).toBe(1);
  });

  it("rolls back failed writes and enforces scope and the pack's permitted pairs", async () => {
    await expect(service.post(teller, { ...request, inputAmount: "999999.00" })).rejects.toBeInstanceOf(LedgerError);
    for (const table of ["ledger_transactions", "ledger_journal_entries", "ledger_till_movements", "ledger_audit_events", "ledger_idempotency"]) {
      expect((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe("0");
    }
    await expect(service.post({ ...teller, branchId: "other", authorizedBranchIds: ["other"] }, { ...request, idempotencyKey: "branch" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.post({ ...teller, tenantId: "other" }, { ...request, idempotencyKey: "tenant" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    // this entity's pack has allow_cross_currency off, and the refusal says so
    await expect(service.post(teller, { ...request, from: "USD", to: "EUR", idempotencyKey: "pair" })).rejects.toMatchObject({ code: "UNSUPPORTED_CURRENCY_PAIR" });
  });

  it("creates compensating reversal evidence and rejects a second reversal", async () => {
    const posted = await service.post(teller, request);
    const reversed = await service.reverse(supervisor, posted.transactionId, "reverse-1", "Correction");
    expect((await pool.query("SELECT * FROM ledger_reversal_entries")).rowCount).toBe(5);
    expect((await pool.query("SELECT * FROM ledger_till_movements WHERE reversal_id=$1 AND movement_kind='reversal'", [reversed.reversalId])).rowCount).toBe(3);
    expect((await service.reverse(supervisor, posted.transactionId, "reverse-1", "Correction")).reversalId).toBe(reversed.reversalId);
    await expect(service.reverse(supervisor, posted.transactionId, "reverse-2", "Again")).rejects.toMatchObject({ code: "REVERSAL_ALREADY_EXISTS" });
  });
});
