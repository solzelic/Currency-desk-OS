import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LedgerError, LedgerService, type LedgerActor } from "../src/ledger/service.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
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
  await pool.query("TRUNCATE ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE");
  await pool.query("INSERT INTO ledger_principals VALUES ('teller-1','tenant-1','le-1','branch-1','workspace-1','till-1','teller','[\"branch-1\"]'),('supervisor-1','tenant-1','le-1','branch-1','workspace-1','till-1','supervisor','[\"branch-1\"]')");
  await pool.query("INSERT INTO ledger_customers VALUES ('customer-1','tenant-1','le-1','branch-1','workspace-1','Customer','Normal','verified')");
  await pool.query("INSERT INTO ledger_rates VALUES ('tenant-1','le-1','branch-1','workspace-1','CAD',1),('tenant-1','le-1','branch-1','workspace-1','USD',0.731),('tenant-1','le-1','branch-1','workspace-1','EUR',0.676),('tenant-1','le-1','branch-1','workspace-1','GBP',0.581)");
  for (const [currency, value] of [["CAD", 25000], ["USD", 12000], ["EUR", 7000], ["GBP", 3500]]) {
    await pool.query("INSERT INTO ledger_till_balances VALUES ('tenant-1','le-1','branch-1','workspace-1','till-1',$1,$2)", [currency, value]);
  }
}

postgres("real PostgreSQL ledger posting", () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new LedgerService(pool);
    await pool.query(await readFile(resolve(process.cwd(), "src/ledger/migration.sql"), "utf8"));
  });
  afterAll(async () => pool.end());
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

  it("rolls back failed writes and enforces scope and Canadian pairs", async () => {
    await expect(service.post(teller, { ...request, inputAmount: "999999.00" })).rejects.toBeInstanceOf(LedgerError);
    for (const table of ["ledger_transactions", "ledger_journal_entries", "ledger_till_movements", "ledger_audit_events", "ledger_idempotency"]) {
      expect((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count).toBe("0");
    }
    await expect(service.post({ ...teller, branchId: "other", authorizedBranchIds: ["other"] }, { ...request, idempotencyKey: "branch" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    await expect(service.post({ ...teller, tenantId: "other" }, { ...request, idempotencyKey: "tenant" })).rejects.toMatchObject({ code: "SCOPE_DENIED" });
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
