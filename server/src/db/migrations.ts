import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql as dbSql } from "drizzle-orm";
import type pg from "pg";

export type Migration = readonly [migrationId: string, path: string];

export const migrations: readonly Migration[] = [
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
  ["023_session_workspace", "src/db/migrations/023_session_workspace.sql"],
  ["024_storefront_holds_decimal", "src/db/migrations/024_storefront_holds_decimal.sql"],
  ["025_platform_mfa", "src/db/migrations/025_platform_mfa.sql"],
  ["026_client_supporting_files", "src/db/migrations/026_client_supporting_files.sql"],
  ["028_pack_rule_fields", "src/db/migrations/028_pack_rule_fields.sql"],
  ["029_pack_ca_v2", "src/db/migrations/029_pack_ca_v2.sql"],
  ["031_pack_eu_amlr", "src/db/migrations/031_pack_eu_amlr.sql"],
  /* 027 and 030 still belong to open drafts. 033 is Serbia. 034 is Australia. 035 is the United Kingdom. 036 is the United Arab Emirates. 037 is India. 038 is the Philippines. */
  ["033_serbia_pack", "src/db/migrations/033_serbia_pack.sql"],
  ["034_pack_au_v2", "src/db/migrations/034_pack_au_v2.sql"],
  ["035_pack_gb_v2", "src/db/migrations/035_pack_gb_v2.sql"],
  ["036_pack_ae_v2", "src/db/migrations/036_pack_ae_v2.sql"],
  ["037_pack_in_v1", "src/db/migrations/037_pack_in_v1.sql"],
  ["038_pack_ph_v1", "src/db/migrations/038_pack_ph_v1.sql"],
  /* 039 is the live-cheque index, now on main. 040 is the till mark.
     041 is claimed by open draft #132. 042 is #130.
     043 is #138. 044 is shop sign-in failure counts and the emailed-code marker. */
  ["039_live_cheque_paper", "src/db/migrations/039_live_cheque_paper.sql"],
  ["040_till_balance_generation", "src/db/migrations/040_till_balance_generation.sql"],
  ["044_signin_rate_limit", "src/db/migrations/044_signin_rate_limit.sql"],
  /* 045 is the default cheque schedule. Deleting this entry fails the backfill test. */
  ["045_cheque_fee_schedule", "src/db/migrations/045_cheque_fee_schedule.sql"],
  /* 046 is the work email on a staff account, and the case-folded staff id index. */
  ["046_staff_contact_email", "src/db/migrations/046_staff_contact_email.sql"],
  /* 047 is the ID types a shop accepts. NULL follows the pack. */
  ["047_accepted_id_types", "src/db/migrations/047_accepted_id_types.sql"],
  /* 048 is the unrounded expected saved beside a count's variance. */
  ["048_till_count_stored_expected", "src/db/migrations/048_till_count_stored_expected.sql"],
  /* 049 is the inquiry-to-shop map. 050 is the per-shop identity-verification config. */
  ["049_idv_inquiry_map", "src/db/migrations/049_idv_inquiry_map.sql"],
  ["050_idv_shop_config", "src/db/migrations/050_idv_shop_config.sql"],
  /* 051 is the inquiry status. 049 and 050 come first. */
  ["051_idv_inquiry_status", "src/db/migrations/051_idv_inquiry_status.sql"],
  /* 052 is identity-check credits. 050 and 051 are on main. */
  ["052_idv_credit_ledger", "src/db/migrations/052_idv_credit_ledger.sql"],
  /* 053 is the booking-error flag beside a prepared or filed LCTR. The filing row is not updated. */
  ["053_lctr_filing_flag", "src/db/migrations/053_lctr_filing_flag.sql"],
  /* 054 is the per-customer lock a reversal takes. A booking does not take it. */
  ["054_watch_customer_lock", "src/db/migrations/054_watch_customer_lock.sql"],
  /* 055 stores each structuring-watch acknowledgement in
     ledger_structuring_watch_acks. The session role is on the row.
     Update, delete, and truncate are refused. */
  ["055_structuring_ack", "src/db/migrations/055_structuring_ack.sql"],
  /* 056 marks a tenant as a staging test shop. Nothing sets it yet.
     055 is on main, so this file is 056. */
  ["056_tenant_test_shop", "src/db/migrations/056_tenant_test_shop.sql"],
] as const;

type MigrationReader = {
  execute: (query: ReturnType<typeof dbSql>) => Promise<{ rows: ReadonlyArray<{ migration_id?: unknown }> }>;
};

/* Health must not keep a pooled connection. Postgres cancels the read.
   PGlite has no statement_timeout, so that path stops waiting in process. */
const MIGRATION_READ_TIMEOUT_MS = 1000;

function postgresPool(db: MigrationReader): pg.Pool | null {
  const client = (db as { session?: { client?: pg.Pool } }).session?.client;
  if (client && typeof client.connect === "function") return client;
  return null;
}

async function newestFromReader(db: MigrationReader): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const found = await Promise.race([
      db.execute(dbSql`
        SELECT migration_id FROM schema_migrations
        ORDER BY applied_at DESC, migration_id DESC
        LIMIT 1
      `),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), MIGRATION_READ_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    const id = found.rows[0]?.migration_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* Newest applied id, or null when the table is missing, the read fails
   (including a connect failure), or Postgres cancels it. Names only. */
export async function newestAppliedMigration(db: MigrationReader): Promise<string | null> {
  const pool = postgresPool(db);
  if (pool) return newestFromPostgres(pool);
  return newestFromReader(db);
}

export async function runMigrations(
  pool: pg.Pool,
  configuredMigrations: readonly Migration[] = migrations,
) {
  /* Before the runner's first query. Name only: no connection string. */
  console.log("opening database");
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
      console.log(`migration applied: ${migrationId}`);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}

/* Below the runner. A pack test takes the first BEGIN in this file as the
   runner's transaction, so this read must not sit above that one.
   Own transaction so SET LOCAL dies with it. Always release the client. */
async function newestFromPostgres(pool: pg.Pool): Promise<string | null> {
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = 1000");
    const found = await client.query(
      "SELECT migration_id FROM schema_migrations ORDER BY applied_at DESC, migration_id DESC LIMIT 1",
    );
    await client.query("COMMIT");
    const id = found.rows[0]?.migration_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    try { await client?.query("ROLLBACK"); } catch { /* the server already aborted it */ }
    return null;
  } finally {
    client?.release();
  }
}
