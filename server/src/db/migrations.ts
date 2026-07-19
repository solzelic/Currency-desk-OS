import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type pg from "pg";

export type Migration = readonly [migrationId: string, path: string];

const migrations: readonly Migration[] = [
  ["001_ledger", "src/ledger/migration.sql"],
  ["002_quote_service", "src/db/migrations/002_quote_service.sql"],
  ["003_quote_transaction_lineage", "src/db/migrations/003_quote_transaction_lineage.sql"],
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
