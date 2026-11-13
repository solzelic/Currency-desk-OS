/* Real independent connections; synthetic tables in a private test schema.
   No provider/network calls. Run with a disposable TEST_DATABASE_URL. */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "../src/db/index.js";
import { syncMarketRates, syncMarketRatesIfStale, type MarketPull } from "../src/rates/market.js";
import { MARKET_PULL_TIMEOUT_MS } from "../src/rates/sync-transaction.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe.sequential : describe.skip;
const HOUR = 3_600_000;
const pull: MarketPull = { provider: "lock-test", providerTimestamp: null, mids: { USD: 1.4 } };
const space = `rates_lock_${randomUUID().replaceAll("-", "")}`;
const poolA = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${space}` });
const poolB = new pg.Pool({ connectionString: url, max: 1, options: `-c search_path=${space}` });
const dbA = drizzle(poolA, { schema });
const dbB = drizzle(poolB, { schema });

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

postgres("cross-instance market sync", () => {
  beforeAll(async () => {
    // Identifier is generated here from a UUID, never external input.
    await poolA.query(`CREATE SCHEMA ${space}`);
    await poolA.query(`
      CREATE TABLE market_rates (id text PRIMARY KEY, provider text NOT NULL,
        mids jsonb NOT NULL, provider_timestamp text, fetched_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE branches (id text PRIMARY KEY, rates_locked_at timestamptz,
        auto_publish_rates boolean NOT NULL DEFAULT false);
      CREATE TABLE legal_entities (id text PRIMARY KEY, home_currency text NOT NULL);
      CREATE TABLE rate_boards (id text PRIMARY KEY, tenant_id text NOT NULL,
        legal_entity_id text NOT NULL, branch_id text NOT NULL,
        buy_margin numeric(24,12) NOT NULL, sell_margin numeric(24,12) NOT NULL,
        board_rows jsonb NOT NULL, board_order jsonb, published_by text,
        market_snapshot_id text, published_at timestamptz NOT NULL DEFAULT now());
    `);
  });
  beforeEach(async () => {
    await poolA.query("TRUNCATE market_rates, branches, legal_entities, rate_boards");
    await poolA.query("INSERT INTO branches (id) VALUES ('primary')");
    await poolA.query("INSERT INTO legal_entities VALUES ('entity', 'CAD')");
    await poolA.query(`INSERT INTO rate_boards
      (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, published_at)
      VALUES ('seed', 'tenant', 'entity', 'primary', .02, .03, '{"USD":{"mid":1.3}}', now() - interval '1 day')`);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    try { await poolA.query(`DROP SCHEMA IF EXISTS ${space} CASCADE`); }
    finally { await Promise.all([poolA.end(), poolB.end()]); }
  });

  it("allows one fetch/store/publication across two single-connection pools; loser skips", async () => {
    const entered = latch();
    const finish = latch();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      if (calls === 1) { entered.release(); await finish.promise; }
      return pull;
    });
    const winner = syncMarketRatesIfStale(dbA, "primary", HOUR, fetcher);
    try {
      await entered.promise;
      const loser = await syncMarketRatesIfStale(dbB, "primary", HOUR, fetcher);
      expect(loser).toMatchObject({ ok: false, skipped: true, detail: "sync already in progress" });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await dbB.select().from(schema.marketRates))).toHaveLength(0);
      // The ungated entry point must share the same lock too.
      expect((await syncMarketRates(dbB, "primary", fetcher)).ok).toBe(false);
    } finally { finish.release(); await winner; }
    expect((await winner).ok).toBe(true);
    expect(await dbB.select().from(schema.marketRates)).toHaveLength(1);
    const boards = await dbB.select().from(schema.rateBoards);
    expect(boards).toHaveLength(2);
    expect(boards.find((board) => board.id !== "seed")?.marketSnapshotId).toBeTruthy();
    expect(await syncMarketRatesIfStale(dbB, "primary", HOUR, fetcher)).toMatchObject({ ok: true, skipped: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("checks freshness after acquiring the connection and lock", async () => {
    const held = await poolB.connect();
    const fetcher = vi.fn(async () => pull);
    const waiting = syncMarketRatesIfStale(dbB, "primary", HOUR, fetcher);
    try {
      expect(poolB.waitingCount).toBe(1);
      expect((await syncMarketRatesIfStale(dbA, "primary", HOUR, async () => pull)).ok).toBe(true);
    } finally { held.release(); }
    expect(await waiting).toMatchObject({ ok: true, skipped: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["fetch", "snapshot", "publication", "freshness"])("releases the lock after %s failure and permits another pool to retry", async (stage) => {
    if (stage === "snapshot") await poolA.query("ALTER TABLE market_rates ADD CONSTRAINT reject_snapshot CHECK (provider <> 'lock-test')");
    if (stage === "publication") await poolA.query("ALTER TABLE rate_boards ADD CONSTRAINT reject_publish CHECK (published_by IS NULL)");
    if (stage === "freshness") await poolA.query("ALTER TABLE market_rates RENAME COLUMN fetched_at TO unavailable");
    try {
      const failed = await syncMarketRatesIfStale(dbA, "primary", HOUR, async () => {
        if (stage === "fetch") throw new Error("synthetic fetch failure");
        return pull;
      });
      expect(failed.ok).toBe(false);
    } finally {
      if (stage === "snapshot") await poolA.query("ALTER TABLE market_rates DROP CONSTRAINT reject_snapshot");
      if (stage === "publication") await poolA.query("ALTER TABLE rate_boards DROP CONSTRAINT reject_publish");
      if (stage === "freshness") await poolA.query("ALTER TABLE market_rates RENAME COLUMN unavailable TO fetched_at");
    }
    expect(await dbB.select().from(schema.marketRates)).toHaveLength(0);
    expect(await syncMarketRatesIfStale(dbB, "primary", HOUR, async () => pull)).toMatchObject({ ok: true, skipped: false });
    expect(await dbB.select().from(schema.marketRates)).toHaveLength(1);
  });

  it("keeps fetching and publication timestamps after the provider returns", async () => {
    let fetchedAfter = "";
    const result = await syncMarketRates(dbA, "primary", async () => {
      const time = await poolB.query<{ stamp: string }>("SELECT clock_timestamp()::text AS stamp");
      const stamp = time.rows[0]?.stamp;
      if (!stamp) throw new Error("database clock missing");
      fetchedAfter = stamp;
      return pull;
    });
    expect(result.ok).toBe(true);
    const timestamps = await poolB.query<{ snapshot_after: boolean; board_after: boolean }>(`
      SELECT m.fetched_at >= $1::timestamptz AS snapshot_after,
             b.published_at >= $1::timestamptz AS board_after
      FROM market_rates m JOIN rate_boards b ON b.market_snapshot_id = m.id`, [fetchedAfter]);
    expect(timestamps.rows).toEqual([{ snapshot_after: true, board_after: true }]);
  });

  it("holds the lock through publication and isolates a failed follower with a savepoint", async () => {
    await poolA.query("INSERT INTO branches (id, auto_publish_rates) VALUES ('bad', true), ('good', true)");
    await poolA.query(`INSERT INTO rate_boards
      SELECT id || '-seed', 'tenant', 'entity', id, .02, .03, '{"USD":{"mid":1.3}}', NULL, NULL, NULL, now() - interval '1 day'
      FROM branches WHERE id <> 'primary'`);
    await poolA.query("ALTER TABLE rate_boards ADD CONSTRAINT reject_bad CHECK (branch_id <> 'bad' OR published_by IS NULL)");
    // A separate observer holds the table lock; both instance pools retain
    // their only connection for the syncs under test.
    const blocker = new pg.Client({ connectionString: url, options: `-c search_path=${space}` });
    let syncing: ReturnType<typeof syncMarketRates> | undefined;
    try {
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE rate_boards IN SHARE MODE");
      syncing = syncMarketRates(dbA, "primary", async () => pull);
      // Observe the actual blocked INSERT, not an arbitrary sleep.
      await vi.waitFor(async () => {
        const waiting = await blocker.query(`SELECT 1 FROM pg_locks
          WHERE relation = 'rate_boards'::regclass AND NOT granted`);
        expect(waiting.rowCount).toBe(1);
      });
      expect(await syncMarketRatesIfStale(dbB, "primary", HOUR, async () => pull))
        .toMatchObject({ ok: false, skipped: true });
      await blocker.query("ROLLBACK");
      const result = await syncing;
      expect(result.ok).toBe(true);
      expect(result.detail).toContain("failed: bad");
      const boards = await dbB.select().from(schema.rateBoards);
      expect(boards.filter((board) => board.marketSnapshotId)).toHaveLength(2);
      expect(await syncMarketRatesIfStale(dbB, "primary", HOUR, async () => pull))
        .toMatchObject({ ok: true, skipped: true });
    } finally {
      // Ending the observer also releases its table lock on assertion failure.
      await blocker.end();
      await syncing;
      await poolA.query("ALTER TABLE rate_boards DROP CONSTRAINT reject_bad");
    }
  });

  it.each(["resolve", "reject"])("bounds a non-cooperative provider and ignores late %s", async (settlement) => {
    const entered = latch();
    let resolve!: (value: MarketPull) => void;
    let reject!: (reason: Error) => void;
    let signal: AbortSignal | undefined;
    const pending = new Promise<MarketPull>((yes, no) => { resolve = yes; reject = no; });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const syncing = syncMarketRates(dbA, "primary", async (value) => {
      signal = value; entered.release(); return pending;
    });
    try {
      await entered.promise;
      const contender = vi.fn(async () => pull);
      expect((await syncMarketRates(dbB, "primary", contender)).ok).toBe(false);
      expect(contender).not.toHaveBeenCalled();
      let readFinished = false;
      const read = poolA.query("SELECT 1").then(() => { readFinished = true; });
      await vi.advanceTimersByTimeAsync(MARKET_PULL_TIMEOUT_MS - 1);
      expect(readFinished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await syncing).toMatchObject({ ok: false, detail: "market provider timed out" });
      await read;
      expect(signal?.aborted).toBe(true);
      expect(await dbB.select().from(schema.marketRates)).toHaveLength(0);
      expect(await dbB.select().from(schema.rateBoards)).toHaveLength(1);
      expect((await syncMarketRates(dbB, "primary", async () => pull)).ok).toBe(true);
      if (settlement === "resolve") resolve({ ...pull, provider: "late-result" });
      else reject(new Error("late rejection"));
      await new Promise<void>((done) => setImmediate(done));
      expect(await dbB.select().from(schema.marketRates)).toHaveLength(1);
      expect(await dbB.select().from(schema.rateBoards)).toHaveLength(2);
      expect((await syncMarketRates(dbA, "primary", async () => pull)).ok).toBe(true);
      expect(poolA.waitingCount).toBe(0);
    } finally {
      resolve(pull);
      await syncing;
      vi.useRealTimers();
    }
  });

  it("removes sync listeners after success, freshness skips and failure", async () => {
    const client = await poolA.connect();
    const count = client.listenerCount("error");
    client.release();
    const idleListeners = client.listeners("error");
    for (let i = 0; i < 3; i += 1) {
      expect((await syncMarketRates(dbA, "primary", async () => pull)).ok).toBe(true);
      expect((await syncMarketRatesIfStale(dbA, "primary", HOUR, async () => pull)).skipped).toBe(true);
      const checked = await poolA.connect();
      expect(checked).toBe(client);
      expect(checked.listenerCount("error")).toBe(count);
      checked.release();
    }
    expect((await syncMarketRates(dbA, "primary", async () => { throw new Error("synthetic"); })).ok).toBe(false);
    // pg-pool retains its own idle listener even on a discarded client.
    expect(client.listeners("error")).toEqual(idleListeners);
    expect(poolA.totalCount).toBe(0);
    expect((await syncMarketRates(dbA, "primary", async () => pull)).ok).toBe(true);
  });

  it("fails and rolls back when the checked-out client emits an error during provider wait", async () => {
    const entered = latch();
    const client = await poolA.connect();
    client.release();
    let signal: AbortSignal | undefined;
    const syncing = syncMarketRates(dbA, "primary", async (value) => {
      signal = value; entered.release(); return new Promise<MarketPull>(() => {});
    });
    await entered.promise;
    client.emit("error", new Error("synthetic client failure"));
    expect(await syncing).toMatchObject({ ok: false, detail: "market sync database connection lost" });
    expect(signal?.aborted).toBe(true);
    expect(await dbB.select().from(schema.marketRates)).toHaveLength(0);
    expect(await dbB.select().from(schema.rateBoards)).toHaveLength(1);
    expect(poolA.totalCount).toBe(0);
    expect((await syncMarketRates(dbA, "primary", async () => pull)).ok).toBe(true);
  });

  it("survives a real backend disconnect during provider wait and recovers both pools", async () => {
    // Identify only this test's sole connection, never an arbitrary backend.
    const client = await poolA.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    client.release();
    const entered = latch();
    const finish = latch();
    let signal: AbortSignal | undefined;
    const syncing = syncMarketRates(dbA, "primary", async (value) => {
      signal = value; entered.release(); await finish.promise;
      return { ...pull, provider: "late-disconnected-result" };
    });
    try {
      await entered.promise;
      const lock = await poolB.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted", [pid]);
      expect(lock.rowCount).toBe(1);
      // PostgreSQL waits for this owned backend to terminate (PG16 in CI).
      const killed = await poolB.query<{ killed: boolean }>("SELECT pg_terminate_backend($1, 1000) AS killed", [pid]);
      expect(killed.rows).toEqual([{ killed: true }]);
      expect(await syncing).toMatchObject({ ok: false, detail: "market sync database connection lost" });
      expect(signal?.aborted).toBe(true);
      expect(await dbB.select().from(schema.marketRates)).toHaveLength(0);
      expect(await dbB.select().from(schema.rateBoards)).toHaveLength(1);
      const remaining = await poolB.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory'", [pid]);
      expect(remaining.rowCount).toBe(0);
      finish.release();
      await new Promise<void>((done) => setImmediate(done));
      expect(await dbB.select().from(schema.marketRates)).toHaveLength(0);
      expect((await syncMarketRates(dbA, "primary", async () => pull)).ok).toBe(true);
      expect((await syncMarketRates(dbB, "primary", async () => pull)).ok).toBe(true);
      expect(await dbB.select().from(schema.marketRates)).toHaveLength(2);
      expect(await dbB.select().from(schema.rateBoards)).toHaveLength(3);
      expect(poolA.waitingCount).toBe(0);
      expect(poolB.waitingCount).toBe(0);
    } finally { finish.release(); await syncing; }
  });

  it("discards a checkout even when BEGIN fails before Drizzle enters its finally", async () => {
    const client = await poolA.connect();
    client.release();
    const query = vi.spyOn(client, "query").mockRejectedValueOnce(new Error("synthetic BEGIN failure"));
    const fetcher = vi.fn(async () => pull);
    try {
      expect((await syncMarketRates(dbA, "primary", fetcher)).ok).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
      expect(poolA.totalCount).toBe(0);
    } finally { query.mockRestore(); }
    expect((await syncMarketRates(dbA, "primary", fetcher)).ok).toBe(true);
  });
});
