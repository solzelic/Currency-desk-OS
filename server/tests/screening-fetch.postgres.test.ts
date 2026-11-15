/* A failed fetch keeps the last good list and raises the ops flag.
   It does not delete entries. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { fetchOne } from "../src/screening/fetch.js";
import { parseCanadaXml } from "../src/screening/parse.js";
import { LIST_SOURCES } from "../src/screening/sources.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const canada = LIST_SOURCES[0]!;
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/sanctions/canada.xml"), "utf8");

postgres("sanctions list fetch", () => {
  let pool: pg.Pool;
  let handle: DbHandle;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
  });

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("keeps the last good entries when the next fetch fails", async () => {
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await pool.query("DELETE FROM sanctions_ops_flags");
    const good = await fetchOne(handle.db, canada, async () => ({ ok: true, status: 200, body: fixture }));
    expect(good).toBe("good");
    const before = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_entries");
    expect(before.rows[0].n).toBe(parseCanadaXml(fixture).length);

    const failed = await fetchOne(handle.db, canada, async () => ({ ok: false, status: 503, body: "" }));
    expect(failed).toBe("failed");
    const after = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_entries");
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const flag = await pool.query("SELECT alert, reason FROM sanctions_ops_flags WHERE source_key = $1", [canada.key]);
    expect(flag.rows[0].alert).toBe(true);
    expect(String(flag.rows[0].reason)).toMatch(/503/);
    const still = await pool.query(
      "SELECT count(*)::int AS n FROM sanctions_list_entries e JOIN sanctions_list_snapshots s ON s.snapshot_id = e.snapshot_id WHERE s.status = 'good'",
    );
    expect(still.rows[0].n).toBe(before.rows[0].n);
  });

  it("does not store a second copy when the hash is unchanged, and clears the alert", async () => {
    const again = await fetchOne(handle.db, canada, async () => ({ ok: true, status: 200, body: fixture }));
    expect(again).toBe("unchanged");
    const goods = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_snapshots WHERE status = 'good' AND source_key = $1", [canada.key]);
    expect(goods.rows[0].n).toBe(1);
    const flag = await pool.query("SELECT alert FROM sanctions_ops_flags WHERE source_key = $1", [canada.key]);
    expect(flag.rows[0].alert).toBe(false);
  });
});
