import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";

export type Migration = readonly [migrationId: string, path: string];

const migrations: readonly Migration[] = [
  ["001_ledger", "src/ledger/migration.sql"],
  ["002_quote_service", "src/db/migrations/002_quote_service.sql"],
  ["003_quote_transaction_lineage", "src/db/migrations/003_quote_transaction_lineage.sql"],
  ["004_ledger_workspace_provisioning", "src/db/migrations/004_ledger_workspace_provisioning.sql"],
  ["005_transaction_compliance_capture", "src/db/migrations/005_transaction_compliance_capture.sql"],
  ["006_till_control", "src/db/migrations/006_till_control.sql"],
  ["007_stripe_billing", "src/db/migrations/007_stripe_billing.sql"],
  ["008_password_reset", "src/db/migrations/008_password_reset.sql"],
  ["009_vault_control", "src/db/migrations/009_vault_control.sql"],
  ["010_cost_basis", "src/db/migrations/010_cost_basis.sql"],
  ["011_jurisdiction_packs", "src/db/migrations/011_jurisdiction_packs.sql"],
  ["012_jurisdiction_reports", "src/db/migrations/012_jurisdiction_reports.sql"],
  ["013_cross_currency_quotes", "src/db/migrations/013_cross_currency_quotes.sql"],
  ["014_cost_method_fifo", "src/db/migrations/014_cost_method_fifo.sql"],
  ["015_report_filing_record", "src/db/migrations/015_report_filing_record.sql"],
  ["016_desk_thresholds", "src/db/migrations/016_desk_thresholds.sql"],
  ["017_cheque_cashing", "src/db/migrations/017_cheque_cashing.sql"],
  ["018_obligations", "src/db/migrations/018_obligations.sql"],
  ["019_client_records", "src/db/migrations/019_client_records.sql"],
  ["020_traded_currencies", "src/db/migrations/020_traded_currencies.sql"],
  ["021_growth_pipeline", "src/db/migrations/021_growth_pipeline.sql"],
  ["022_growth_operations", "src/db/migrations/022_growth_operations.sql"],
] as const;

export async function runMigrations(
  pool: pg.Pool,
  configuredMigrations: readonly Migration[] = migrations,
) {
  const ordered = [...configuredMigrations].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (new Set(ordered.map(([migrationId]) => migrationId)).size !== ordered.length)
    throw new Error("Duplicate migration identifier.");
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (migration_id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const [migrationId, path] of ordered) {
    const sql = await readFile(resolve(process.cwd(), path), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const applied = await pool.query("SELECT checksum FROM schema_migrations WHERE migration_id=$1", [migrationId]);
    if (applied.rowCount) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`Migration checksum drift: ${migrationId}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (migration_id,checksum) VALUES ($1,$2)", [migrationId, checksum]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
