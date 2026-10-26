/* Boot of migration 055 when a branch preview left an older table behind.
   The stray name is assembled in code. The fixture files are the exact
   historical SQL with that name replaced by __STRAY__, checked by sha256. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { provisionPostgres } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { WATCH_ACK_TABLE } from "../src/ledger/structuring-watch.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const stray = ["ledger", "structuring", "acks"].join("_");
const LATER = "17aa141ec43ce5d0d0ab8527f69eb9eb92033be99b9d175fbb5e8db88bdef2c3";
const ROUND1 = "1304d8b0b1fd0f0de19e633e5166df1097bf6799dff5194f388fefabbf66cdba";
const pools: pg.Pool[] = [];
const names: string[] = [];

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

async function historical(file: string, sha: string) {
  const tokenized = await readFile(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
  const sql = tokenized.replaceAll("__STRAY__", stray);
  expect(createHash("sha256").update(sql).digest("hex")).toBe(sha);
  return sql;
}

async function planted(name: string, sql: string) {
  const dbUrl = await makeDb(name);
  const pool = hold(await provisionPostgres(dbUrl));
  await pool.query("DELETE FROM schema_migrations WHERE migration_id = $1", ["055_structuring_ack"]);
  await pool.query(`DROP TABLE IF EXISTS ${WATCH_ACK_TABLE}`);
  await pool.query(`DROP TABLE IF EXISTS ${stray}`);
  await pool.query(sql);
  await pool.query(
    "INSERT INTO schema_migrations (migration_id, checksum) VALUES ($1, $2)",
    ["054_structuring_ack", "branch-preview"],
  );
  return { pool, dbUrl };
}

async function recorded(pool: pg.Pool, id: string) {
  const row = await pool.query(
    "SELECT count(*)::int AS n FROM schema_migrations WHERE migration_id = $1",
    [id],
  );
  return row.rows[0].n as number;
}

async function columns(pool: pg.Pool, table: string) {
  const found = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return found.rows.map((row) => row.column_name as string);
}

async function refusesWrites(pool: pg.Pool) {
  await pool.query(
    `INSERT INTO ${WATCH_ACK_TABLE}
       (tenant_id, legal_entity_id, branch_id, customer_id,
        actor_id, actor_role, deal_ids)
     VALUES ('t','e','b','c','a','administrator', ARRAY['d1'])`,
  );
  await expect(
    pool.query(`UPDATE ${WATCH_ACK_TABLE} SET actor_id = actor_id`),
  ).rejects.toThrow(/append-only/);
  await expect(pool.query(`DELETE FROM ${WATCH_ACK_TABLE}`)).rejects.toThrow(/append-only/);
  await expect(pool.query(`TRUNCATE ${WATCH_ACK_TABLE}`)).rejects.toThrow(/append-only/);
}

postgres("structuring acknowledgement boot", () => {
  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    if (!url) return;
    const admin = new pg.Pool({ connectionString: maintenance(url) });
    for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("boots over the later stray table and still refuses writes", async () => {
    const { pool } = await planted("currencydesk_ackboot_a", await historical("stray-ack-later.sql", LATER));
    await pool.query(
      `INSERT INTO ${stray}
         (tenant_id, legal_entity_id, branch_id, customer_id,
          actor_id, actor_role, deal_ids)
       VALUES ('t','e','b','kept','actor','administrator', ARRAY['deal-1'])`,
    );
    await runMigrations(pool);
    expect(await recorded(pool, "054_watch_customer_lock")).toBe(1);
    expect(await recorded(pool, "054_structuring_ack")).toBe(1);
    expect(await recorded(pool, "055_structuring_ack")).toBe(1);
    expect(await columns(pool, WATCH_ACK_TABLE)).toEqual(
      expect.arrayContaining(["actor_role", "deal_ids"]),
    );
    const kept = await pool.query(
      `SELECT count(*)::int AS n FROM ${stray} WHERE customer_id = 'kept'`,
    );
    expect(kept.rows[0].n).toBe(1);
    await refusesWrites(pool);
  }, 120000);

  it("boots that same stray table through provisionPostgres", async () => {
    const plantedDb = await planted(
      "currencydesk_ackboot_b",
      await historical("stray-ack-later.sql", LATER),
    );
    const again = hold(await provisionPostgres(plantedDb.dbUrl));
    expect(await recorded(again, "055_structuring_ack")).toBe(1);
    await refusesWrites(again);
  }, 120000);

  it("boots over the round 1 table and leaves that table untouched", async () => {
    const { pool } = await planted(
      "currencydesk_ackboot_c",
      await historical("stray-ack-round1.sql", ROUND1),
    );
    await pool.query(
      `INSERT INTO ${stray}
         (tenant_id, legal_entity_id, branch_id, customer_id, actor_id)
       VALUES ('t','e','b','kept','actor')`,
    );
    const before = await columns(pool, stray);
    await runMigrations(pool);
    expect(await columns(pool, stray)).toEqual(before);
    expect(before).not.toContain("actor_role");
    expect(before).not.toContain("deal_ids");
    expect(await columns(pool, WATCH_ACK_TABLE)).toEqual(
      expect.arrayContaining(["actor_role", "deal_ids"]),
    );
    const kept = await pool.query(`SELECT actor_id FROM ${stray} WHERE customer_id = 'kept'`);
    expect(kept.rows[0].actor_id).toBe("actor");
  }, 120000);

  it("applies 055 on a clean database at 054 and on a fresh database", async () => {
    const clean = hold(await provisionPostgres(await makeDb("currencydesk_ackboot_d")));
    await clean.query("DELETE FROM schema_migrations WHERE migration_id = $1", ["055_structuring_ack"]);
    await clean.query(`DROP TABLE IF EXISTS ${WATCH_ACK_TABLE}`);
    expect(await recorded(clean, "054_watch_customer_lock")).toBe(1);
    await runMigrations(clean);
    expect(await recorded(clean, "055_structuring_ack")).toBe(1);
    expect((await clean.query("SELECT to_regclass($1) AS name", [stray])).rows[0].name).toBeNull();
    expect(await columns(clean, WATCH_ACK_TABLE)).toEqual(
      expect.arrayContaining(["actor_role", "deal_ids"]),
    );
    const fresh = hold(await provisionPostgres(await makeDb("currencydesk_ackboot_fresh")));
    expect(await recorded(fresh, "055_structuring_ack")).toBe(1);
    expect((await fresh.query("SELECT to_regclass($1) AS name", [stray])).rows[0].name).toBeNull();
    expect(await columns(fresh, WATCH_ACK_TABLE)).toContain("actor_role");
  }, 120000);

  it("treats a second run and a direct re-exec of 055 as a no-op", async () => {
    const pool = hold(await provisionPostgres(await makeDb("currencydesk_ackboot_e")));
    await runMigrations(pool);
    const sql = await readFile(
      new URL("../src/db/migrations/055_structuring_ack.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    expect(await recorded(pool, "055_structuring_ack")).toBe(1);
    await refusesWrites(pool);
  }, 120000);

  it("raises when the new table is missing a column and does not record 055", async () => {
    const pool = hold(await provisionPostgres(await makeDb("currencydesk_ackboot_f")));
    await pool.query("DELETE FROM schema_migrations WHERE migration_id = $1", ["055_structuring_ack"]);
    await pool.query(`DROP TABLE IF EXISTS ${WATCH_ACK_TABLE}`);
    await pool.query(`DROP TABLE IF EXISTS ${stray}`);
    await pool.query(
      `CREATE TABLE ${WATCH_ACK_TABLE} (
         ack_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         tenant_id text NOT NULL,
         legal_entity_id text NOT NULL,
         branch_id text NOT NULL,
         customer_id text NOT NULL,
         actor_id text NOT NULL,
         deal_ids text[] NOT NULL,
         acknowledged_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await expect(runMigrations(pool)).rejects.toThrow(/column actor_role missing or wrong/);
    expect(await recorded(pool, "055_structuring_ack")).toBe(0);
  }, 120000);
});
