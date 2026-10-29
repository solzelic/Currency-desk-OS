/* Dummy URL only. pg.Pool is replaced in this file so nothing connects. */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { createDb, provisionPostgres } from "../src/db/index.js";

const DUMMY = "postgres://pool-error:dummy@127.0.0.1:1/none";
type PoolConfig = { connectionString?: string; max?: number };
const created: FakePool[] = [];
const originalPool = pg.Pool;

class FakePool extends EventEmitter {
  config: PoolConfig;
  constructor(config: PoolConfig = {}) {
    super();
    this.config = config;
    created.push(this);
  }
  query() { return Promise.resolve({ rows: [{ present: 1 }], rowCount: 1 }); }
  connect() {
    return Promise.resolve({
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      release: () => {},
    });
  }
  end() { return Promise.resolve(); }
}

afterEach(() => {
  pg.Pool = originalPool;
  created.length = 0;
  vi.unstubAllEnvs();
});

describe("pool error listeners on the long-lived pools", () => {
  it("listens on the pool provisionPostgres returns", async () => {
    pg.Pool = FakePool as unknown as typeof pg.Pool;
    const pool = await provisionPostgres(DUMMY, []);
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it("listens on the auth, ledger, quote, client, and credit pools", async () => {
    pg.Pool = FakePool as unknown as typeof pg.Pool;
    vi.stubEnv("PGLITE_MEMORY", "1");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("LEDGER_DATABASE_URL", "");
    const handle = await createDb();
    vi.stubEnv("DATABASE_URL", DUMMY);
    vi.stubEnv("LEDGER_DATABASE_URL", DUMMY);
    const app = await buildApp(handle.db);
    try {
      const auth = created.filter((pool) => pool.config.max === 2);
      const others = created.filter((pool) => pool.config.max === undefined);
      expect(auth).toHaveLength(1);
      expect(others).toHaveLength(4);
      for (const pool of [...auth, ...others]) {
        expect(pool.listenerCount("error")).toBeGreaterThan(0);
        expect(pool.config.connectionString).toBe(DUMMY);
      }
    } finally {
      await app.close();
      await handle.close();
    }
  });
});
