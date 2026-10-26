/* Migration 056 on a database that is already at 055, and on a fresh one.
   The shared boot DDL does not add is_test_shop. A leftover column of
   the wrong shape raises and is not adopted. */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { provisionPostgres } from "../src/db/index.js";
import { migrations, runMigrations } from "../src/db/migrations.js";

const ID = "056_tenant_test_shop";
const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const pools: pg.Pool[] = [];
const names: string[] = [];
const TRIGGERS = [
  "ledger_audit_immutable",
  "ledger_journal_immutable",
  "ledger_movements_immutable",
  "ledger_tx_immutable",
];

function hold(pool: pg.Pool) {
  pool.on("error", () => {});
  pools.push(pool);
  return pool;
}

function maintenance(raw: string) {
  const parsed = new URL(raw);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

async function makeDb(name: string) {
  names.push(name);
  const admin = new pg.Pool({ connectionString: maintenance(url!) });
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const parsed = new URL(url!);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

async function recorded(pool: pg.Pool, id: string) {
  const row = await pool.query(
    "SELECT count(*)::int AS n FROM schema_migrations WHERE migration_id = $1",
    [id],
  );
  return row.rows[0]?.n as number;
}

async function marker(pool: pg.Pool) {
  const found = await pool.query(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'is_test_shop'`,
  );
  return found.rows[0] as { is_nullable: string; column_default: string | null } | undefined;
}

async function immutability(pool: pg.Pool) {
  const fn = await pool.query(
    "SELECT pg_get_functiondef('public.ledger_append_only()'::regprocedure) AS def",
  );
  const triggers = await pool.query(
    `SELECT t.tgname, t.tgenabled::text AS enabled
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname = ANY($1::text[])
      ORDER BY t.tgname`,
    [TRIGGERS],
  );
  return { def: String(fn.rows[0]?.def), triggers: triggers.rows };
}

describe("migration 056 is registered after 055", () => {
  it("adds is_test_shop and does not create a table or replace a trigger", async () => {
    const ids = migrations.map(([id]) => id);
    expect(ids.indexOf(ID)).toBe(ids.indexOf("055_structuring_ack") + 1);
    expect(ids.indexOf("057_handover_audit_fields")).toBe(ids.indexOf(ID) + 1);
    expect(ids.at(-1)).toBe("058_handover_approver_and_variances");
    const sql = await readFile(new URL(`../src/db/migrations/${ID}.sql`, import.meta.url), "utf8");
    expect(sql).toMatch(/ADD COLUMN is_test_shop boolean NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/if not exists/i);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/drop\s+trigger/i);
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(sql).not.toMatch(/ledger_append_only/i);
  });

  it("does not add is_test_shop in the shared boot DDL", async () => {
    const src = await readFile(new URL("../src/db/index.ts", import.meta.url), "utf8");
    const start = src.indexOf("const DDL = `");
    const end = src.indexOf("\n`;", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toMatch(/is_test_shop/);
  });
});

postgres("migration 056 upgrades 055 and a fresh database", () => {
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (!url) return;
    const admin = new pg.Pool({ connectionString: maintenance(url) });
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("adds the marker on a database stopped at 055 and on a fresh database", async () => {
    const prior = migrations.filter(([id]) => id !== ID);
    const upgrade = hold(await provisionPostgres(await makeDb("currencydesk_shop056_up"), prior));
    expect(await recorded(upgrade, "055_structuring_ack")).toBe(1);
    expect(await recorded(upgrade, ID)).toBe(0);
    await upgrade.query("ALTER TABLE tenants DROP COLUMN IF EXISTS is_test_shop");
    expect(await marker(upgrade)).toBeUndefined();
    const before = await immutability(upgrade);
    expect(before.triggers.map((row) => row.tgname)).toEqual(TRIGGERS);
    expect(before.def).toMatch(/append-only ledger record/);
    for (const row of before.triggers) expect(row.enabled).toBe("O");
    await upgrade.query("INSERT INTO tenants (id, name) VALUES ('tnt-at-055', 'Shop at 055')");

    await runMigrations(upgrade);
    expect(await recorded(upgrade, ID)).toBe(1);
    expect(await marker(upgrade)).toEqual({ is_nullable: "NO", column_default: "false" });
    const kept = await upgrade.query("SELECT is_test_shop FROM tenants WHERE id = 'tnt-at-055'");
    expect(kept.rows[0]?.is_test_shop).toBe(false);
    const after = await immutability(upgrade);
    expect(after).toEqual(before);

    await runMigrations(upgrade);
    const sql = await readFile(new URL(`../src/db/migrations/${ID}.sql`, import.meta.url), "utf8");
    await upgrade.query(sql);
    expect(await recorded(upgrade, ID)).toBe(1);
    expect((await upgrade.query("SELECT count(*)::int AS n FROM tenants WHERE is_test_shop")).rows[0]?.n).toBe(0);

    const fresh = hold(await provisionPostgres(await makeDb("currencydesk_shop056_fresh")));
    expect(await recorded(fresh, "055_structuring_ack")).toBe(1);
    expect(await recorded(fresh, ID)).toBe(1);
    expect(await marker(fresh)).toEqual({ is_nullable: "NO", column_default: "false" });
    await fresh.query("INSERT INTO tenants (id, name) VALUES ('tnt-fresh', 'Fresh shop')");
    expect((await fresh.query("SELECT is_test_shop FROM tenants WHERE id = 'tnt-fresh'")).rows[0]?.is_test_shop).toBe(false);
    await fresh.query(sql);
    const freshLocks = await immutability(fresh);
    expect(freshLocks.triggers.map((row) => row.tgname)).toEqual(TRIGGERS);
    expect(freshLocks.def).toMatch(/append-only ledger record/);
  }, 180_000);

  async function stoppedAt055(name: string) {
    const prior = migrations.filter(([id]) => id !== ID);
    const pool = hold(await provisionPostgres(await makeDb(name), prior));
    expect(await recorded(pool, "055_structuring_ack")).toBe(1);
    expect(await recorded(pool, ID)).toBe(0);
    await pool.query("ALTER TABLE tenants DROP COLUMN IF EXISTS is_test_shop");
    expect(await marker(pool)).toBeUndefined();
    return pool;
  }

  async function refusesLeftover(name: string, addColumn: string, planted: string, kept: unknown) {
    const pool = await stoppedAt055(name);
    await pool.query(`ALTER TABLE tenants ${addColumn}`);
    await pool.query(
      "INSERT INTO tenants (id, name, is_test_shop) VALUES ('tnt-yorkfx', 'York FX', " + planted + ")",
    );
    await expect(runMigrations(pool)).rejects.toThrow(/is_test_shop/);
    expect(await recorded(pool, ID)).toBe(0);
    const row = await pool.query("SELECT is_test_shop FROM tenants WHERE id = 'tnt-yorkfx'");
    expect(row.rows[0]?.is_test_shop).toEqual(kept);
    expect(await marker(pool)).not.toEqual({ is_nullable: "NO", column_default: "false" });
  }

  it("refuses a text is_test_shop left on a database at 055", async () => {
    await refusesLeftover(
      "currencydesk_shop056_text",
      "ADD COLUMN is_test_shop text",
      "'leftover'",
      "leftover",
    );
  }, 180_000);

  it("refuses a nullable boolean is_test_shop left on a database at 055", async () => {
    await refusesLeftover(
      "currencydesk_shop056_null",
      "ADD COLUMN is_test_shop boolean",
      "true",
      true,
    );
  }, 180_000);

  it("refuses a boolean is_test_shop whose default is true on a database at 055", async () => {
    await refusesLeftover(
      "currencydesk_shop056_true",
      "ADD COLUMN is_test_shop boolean NOT NULL DEFAULT true",
      "DEFAULT",
      true,
    );
  }, 180_000);
});
