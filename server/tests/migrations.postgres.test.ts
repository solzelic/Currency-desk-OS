import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations, type Migration } from "../src/db/migrations.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
const first: Migration = ["test_001_first", "tests/fixtures/migrations/001_first.sql"];
const second: Migration = ["test_002_second", "tests/fixtures/migrations/002_second.sql"];

postgres("tracked PostgreSQL migrations", () => {
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }); });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await pool.query("DROP TABLE IF EXISTS migration_fixture_partial,migration_fixture_second,migration_fixture_first CASCADE");
    await pool.query("DELETE FROM schema_migrations WHERE migration_id LIKE 'test_%'");
  });

  it("applies a fresh migration set once in deterministic identifier order and safely reruns", async () => {
    await runMigrations(pool, [second, first]);
    expect((await pool.query("SELECT migration_id FROM schema_migrations WHERE migration_id LIKE 'test_%' ORDER BY migration_id")).rows.map((row) => row.migration_id)).toEqual(["test_001_first", "test_002_second"]);
    await runMigrations(pool, [first, second]);
    expect((await pool.query("SELECT count(*) FROM schema_migrations WHERE migration_id LIKE 'test_%'")).rows[0].count).toBe("2");
  });

  it("fails loudly on checksum drift", async () => {
    await runMigrations(pool, [first, second]);
    await expect(runMigrations(pool, [first, ["test_002_second", "tests/fixtures/migrations/002_second_changed.sql"]])).rejects.toThrow("Migration checksum drift: test_002_second");
  });

  it("rolls back a partially failing migration and does not record it", async () => {
    await expect(runMigrations(pool, [["test_003_partial", "tests/fixtures/migrations/003_partial_failure.sql"]])).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('migration_fixture_partial') AS table_name")).rows[0].table_name).toBeNull();
    expect((await pool.query("SELECT count(*) FROM schema_migrations WHERE migration_id='test_003_partial'")).rows[0].count).toBe("0");
  });

  it("still applies a migration that has no recorded row", async () => {
    await runMigrations(pool, [first]);
    await runMigrations(pool, [second, first]);
    expect((await pool.query("SELECT migration_id FROM schema_migrations WHERE migration_id LIKE 'test_%' ORDER BY migration_id")).rows.map((row) => row.migration_id)).toEqual(["test_001_first", "test_002_second"]);
  });

  /* Steady-state boot used to pay one round trip per migration file.
     The check itself is unchanged: one read of the whole table has to
     be enough to skip what matches, refuse what drifted, and apply
     what is missing. */
  it("reads every recorded checksum in one query", async () => {
    await runMigrations(pool, [first, second]);
    const seen: string[] = [];
    const watched = {
      query(text: string, values?: unknown[]) {
        seen.push(text);
        return pool.query(text, values);
      },
      connect: () => pool.connect(),
    } as unknown as pg.Pool;
    await runMigrations(watched, [first, second]);
    const selects = seen.filter((query) => /^\s*select\b/i.test(query) && /schema_migrations/i.test(query));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toMatch(/migration_id/i);
    expect(selects[0]).toMatch(/checksum/i);
    expect(seen.some((query) => /where migration_id\s*=\s*\$1/i.test(query))).toBe(false);
  });
});
