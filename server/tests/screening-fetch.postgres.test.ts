/* A failed fetch keeps the last good list and raises the ops flag.
   It does not delete entries. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { fetchOne, pinnedRedirect } from "../src/screening/fetch.js";
import { parseCanadaXml } from "../src/screening/parse.js";
import { LIST_SOURCES } from "../src/screening/sources.js";
import type { ListSource } from "../src/screening/sources.js";
import { storeGood } from "../src/screening/store.js";
import type { ListEntry } from "../src/screening/match.js";
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

  it("keeps the previous good snapshot when a batch crashes, and never marks that batch good", async () => {
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    const source = { key: "ca-sema", url: canada.url };
    const first: ListEntry[] = [{ key: "ca|keep", names: ["Kept Person"], dobs: [] }];
    await storeGood(handle.db, source, "first-body", first, null);
    const next: ListEntry[] = Array.from({ length: 81 }, (_, index) => ({
      key: `ca|next-${index}`,
      names: [`Next Person ${index}`],
      dobs: [],
    }));
    await expect(storeGood(handle.db, source, "second-body", next, {
      snapshotId: "old",
      hash: "first",
      keys: ["ca|keep"],
    }, {
      afterBatch: () => { throw new Error("crash"); },
    })).rejects.toThrow(/crash/);
    const good = await pool.query("SELECT status FROM sanctions_list_snapshots WHERE status = 'good'");
    expect(good.rowCount).toBe(1);
    const writing = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_snapshots WHERE status = 'writing'");
    expect(writing.rows[0].n).toBe(0);
    const keys = await pool.query("SELECT entry_key FROM sanctions_list_entries");
    expect(keys.rows.map((row) => row.entry_key)).toEqual(["ca|keep"]);
  });

  it("fails closed on a well-formed list that shrank by more than 10 percent", async () => {
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await pool.query("DELETE FROM sanctions_ops_flags");
    const source: ListSource = {
      key: "un-sc",
      url: LIST_SOURCES[1]!.url,
      parse: (body) => (JSON.parse(body) as string[]).map((name, index) => ({
        key: `un|${index}`,
        names: [name],
        dobs: [],
      })),
    };
    const full = JSON.stringify(Array.from({ length: 10 }, (_, index) => `Person ${index}`));
    expect(await fetchOne(handle.db, source, async () => ({ ok: true, status: 200, body: full }))).toBe("good");
    const short = JSON.stringify(Array.from({ length: 8 }, (_, index) => `Person ${index}`));
    expect(await fetchOne(handle.db, source, async () => ({ ok: true, status: 200, body: short }))).toBe("failed");
    const goods = await pool.query(
      "SELECT entry_count FROM sanctions_list_snapshots WHERE source_key = 'un-sc' AND status = 'good'",
    );
    expect(goods.rows).toEqual([{ entry_count: 10 }]);
    const entries = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_entries");
    expect(entries.rows[0].n).toBe(10);
    const flag = await pool.query("SELECT alert, reason FROM sanctions_ops_flags WHERE source_key = 'un-sc'");
    expect(flag.rows[0].alert).toBe(true);
    expect(String(flag.rows[0].reason)).toMatch(/10 percent/);
  });

  it("keeps the last good list when a redirect leaves the official host", async () => {
    await pool.query("DELETE FROM sanctions_list_entries");
    await pool.query("DELETE FROM sanctions_list_snapshots");
    await pool.query("DELETE FROM sanctions_ops_flags");
    const source: ListSource = {
      key: "ca-cc",
      url: LIST_SOURCES[2]!.url,
      parse: () => [{ key: "cc|1", names: ["Listed One"], dobs: [] }],
    };
    expect(await fetchOne(handle.db, source, async () => ({ ok: true, status: 200, body: "listed-one" }))).toBe("good");
    const failed = await fetchOne(handle.db, source, async () => {
      pinnedRedirect(source.url, "https://evil.example/list");
      return { ok: true, status: 200, body: "should-not-store" };
    });
    expect(failed).toBe("failed");
    const goods = await pool.query("SELECT count(*)::int AS n FROM sanctions_list_snapshots WHERE status = 'good' AND source_key = 'ca-cc'");
    expect(goods.rows[0].n).toBe(1);
    const flag = await pool.query("SELECT alert, reason FROM sanctions_ops_flags WHERE source_key = 'ca-cc'");
    expect(flag.rows[0].alert).toBe(true);
    expect(String(flag.rows[0].reason)).toMatch(/official host/);
  });
});
