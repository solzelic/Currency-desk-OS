/* Deploy markers on the public probe, and the boot log from the
   migration runner. The newest id comes from the migrations directory.
   These tests read TEST_DATABASE_URL or use PGlite. */
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, provisionPostgres, schema, type DbHandle } from "../src/db/index.js";
import { migrations, runMigrations } from "../src/db/migrations.js";

const savedCommit = process.env.RENDER_GIT_COMMIT;
const testDatabaseUrl = process.env.TEST_DATABASE_URL;

afterAll(() => {
  if (savedCommit === undefined) delete process.env.RENDER_GIT_COMMIT;
  else process.env.RENDER_GIT_COMMIT = savedCommit;
});

async function newestMigrationId(): Promise<string> {
  const dir = fileURLToPath(new URL("../src/db/migrations/", import.meta.url));
  const names = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const file = names.at(-1);
  if (!file) throw new Error("no migration files");
  return file.slice(0, -4);
}

describe("GET /api/health deploy markers", () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PGLITE_MEMORY = "1";
    handle = await createDb();
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
  });

  it("includes commit and lastMigration", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("currencydesk-server");
    expect(body).toHaveProperty("commit");
    expect(body).toHaveProperty("lastMigration");
  });

  it("uses unknown when RENDER_GIT_COMMIT is unset and a 7 character sha when set", async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const unset = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(unset.commit).toBe("unknown");
    process.env.RENDER_GIT_COMMIT = "abcdef1234567890dead";
    const set = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(set.commit).toBe("abcdef1");
    expect(set.commit).toHaveLength(7);
  });
});

const live = testDatabaseUrl ? describe : describe.skip;

live("fresh migrate markers", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let databaseName = "";
  let freshUrl = "";
  let bootLog: string[] = [];
  let unlock: (() => Promise<void>) | null = null;

  afterEach(async () => {
    const release = unlock;
    unlock = null;
    if (release) await release();
  });

  beforeAll(async () => {
    if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
    databaseName = `hd_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    await admin.end();
    const fresh = new URL(testDatabaseUrl);
    fresh.pathname = `/${databaseName}`;
    freshUrl = fresh.toString();
    const orig = console.log;
    console.log = (...args: unknown[]) => { bootLog.push(args.map(String).join(" ")); };
    try {
      pool = await provisionPostgres(fresh.toString());
    } finally {
      console.log = orig;
    }
    app = await buildApp(drizzle(pool, { schema }));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (!testDatabaseUrl || !databaseName) return;
    const admin = new pg.Client({ connectionString: testDatabaseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  it("sets lastMigration to the newest migration file id", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(body.ok).toBe(true);
    expect(body.lastMigration).toBe(await newestMigrationId());
  });

  it("logs one applied migration line and none on a second run", async () => {
    const expected = [...migrations]
      .map(([id]) => id)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => `migration applied: ${id}`);
    expect(bootLog[0]).toBe("opening database");
    expect(bootLog.filter((line) => line.startsWith("migration applied:"))).toEqual(expected);
    expect(bootLog.join("\n")).not.toMatch(/postgres:\/\/|DATABASE_URL/i);
    const again: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { again.push(args.map(String).join(" ")); };
    try {
      await runMigrations(pool);
    } finally {
      console.log = orig;
    }
    expect(again.filter((line) => line.startsWith("migration applied:"))).toEqual([]);
  });

  /* More calls than the pool (10). A vitest timeout makes a stuck pool
     fail the run instead of hanging it. The lock is dropped in afterEach
     when that timeout abandons this body. */
  it("answers health and SELECT 1 while schema_migrations stays locked", async () => {
    const locker = new pg.Client({ connectionString: freshUrl });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try { await locker.query("ROLLBACK"); } catch { /* already closed */ }
      try { await locker.end(); } catch { /* already closed */ }
    };
    unlock = release;
    await locker.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE");
      const blocked = await Promise.all(
        Array.from({ length: 11 }, () => app.inject({ method: "GET", url: "/api/health" })),
      );
      for (const res of blocked) {
        expect(res.statusCode).toBe(200);
        expect(res.json().lastMigration).toBeNull();
      }
      const healthAt = Date.now();
      const again = await app.inject({ method: "GET", url: "/api/health" });
      expect(Date.now() - healthAt).toBeLessThan(1500);
      expect(again.statusCode).toBe(200);
      const selectAt = Date.now();
      await pool.query("SELECT 1");
      expect(Date.now() - selectAt).toBeLessThan(1500);
    } finally {
      await release();
    }
  }, 12_000);
});
