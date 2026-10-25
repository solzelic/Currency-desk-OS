/* A reversal takes a per-customer advisory lock. The same customer waits.
   A different customer does not. The lock ends on commit and on rollback.
   Bookings do not take it. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe.sequential : describe.skip;
const TENANT = "tnt-watch-lock";
const ENTITY = "le-watch-lock";
const BRANCH = "br-watch-lock";
const WORKSPACE = "ws-watch-lock";
const TILL = "till-watch-lock";
const LOCK = "SELECT ledger_lock_watch_customer($1, $2, $3, $4)";
const DEAL = `INSERT INTO ledger_transactions (
  transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
  workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
  input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
  source_of_funds, posted_at, deal_kind, received_instrument,
  disbursed_instrument, cash_in_home, home_currency, third_party
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, 'teller', 'CAD', 'USD',
  10, 7, 1, 0, 0, 'Travel', 'Salary', now(),
  'exchange', 'cash', 'cash', 10, 'CAD', false
)`;
const REVERSAL = `INSERT INTO ledger_reversals (
  reversal_id, transaction_id, actor_id, reason, posted_at
) VALUES ($1, $2, 'supervisor', 'Customer changed their mind', now())`;

let handle: DbHandle;
let pool: pg.Pool;

type Sql = pg.Pool | pg.PoolClient;

async function deal(client: Sql, id: string, customerId: string) {
  await client.query(DEAL, [
    id, `ref-${id}`, TENANT, ENTITY, BRANCH, WORKSPACE, TILL, customerId,
  ]);
}

async function pidOf(client: pg.PoolClient) {
  const found = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(found.rows[0]?.pid);
}

async function grantedAdvisory(pid: number) {
  const found = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM pg_locks
      WHERE pid = $1
        AND locktype = 'advisory'
        AND granted`,
    [pid],
  );
  return Number(found.rows[0]?.n ?? 0);
}

/* Poll pg_locks until that backend is waiting. A sleep would only guess. */
async function untilWaiting(pid: number) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_locks
        WHERE pid = $1
          AND locktype = 'advisory'
          AND NOT granted`,
      [pid],
    );
    if (Number(found.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`backend ${pid} did not wait on an advisory lock`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function reversalCount(id: string) {
  const found = await pool.query(
    "SELECT reversal_id FROM ledger_reversals WHERE reversal_id = $1",
    [id],
  );
  return found.rowCount ?? 0;
}

postgres("reversal watch customer lock", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("blocks a same-customer reversal until the holder commits", async () => {
    await deal(pool, "wl-x1", "customer-x");
    await deal(pool, "wl-x2", "customer-x");
    const first = await pool.connect();
    const second = await pool.connect();
    const firstPid = await pidOf(first);
    const secondPid = await pidOf(second);
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await first.query("BEGIN");
      await first.query(LOCK, [TENANT, ENTITY, BRANCH, "customer-x"]);
      expect(await grantedAdvisory(firstPid)).toBe(1);
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '8s'");
      pending = second.query(REVERSAL, ["rv-wl-x2", "wl-x2"]).catch((error: unknown) => error);
      await untilWaiting(secondPid);
      await first.query("COMMIT");
      expect(await grantedAdvisory(firstPid)).toBe(0);
      const outcome = await pending;
      if (outcome instanceof Error) throw outcome;
      expect(await grantedAdvisory(secondPid)).toBe(1);
      await second.query("COMMIT");
      expect(await grantedAdvisory(secondPid)).toBe(0);
      expect(await reversalCount("rv-wl-x2")).toBe(1);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await pending;
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  }, 20_000);

  it("does not block a reversal for a different customer", async () => {
    await deal(pool, "wl-y1", "customer-y");
    const first = await pool.connect();
    const second = await pool.connect();
    const firstPid = await pidOf(first);
    const secondPid = await pidOf(second);
    try {
      await first.query("BEGIN");
      await first.query(LOCK, [TENANT, ENTITY, BRANCH, "customer-x"]);
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '2s'");
      await second.query(REVERSAL, ["rv-wl-y1", "wl-y1"]);
      expect(await grantedAdvisory(firstPid)).toBe(1);
      expect(await grantedAdvisory(secondPid)).toBe(1);
      await second.query("COMMIT");
      expect(await grantedAdvisory(secondPid)).toBe(0);
      expect(await grantedAdvisory(firstPid)).toBe(1);
      expect(await reversalCount("rv-wl-y1")).toBe(1);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  }, 20_000);

  it("takes the lock on reversal insert, and rollback lets the next one in", async () => {
    await deal(pool, "wl-x3", "customer-x");
    await deal(pool, "wl-x4", "customer-x");
    const first = await pool.connect();
    const second = await pool.connect();
    const firstPid = await pidOf(first);
    const secondPid = await pidOf(second);
    let pending: Promise<unknown> = Promise.resolve();
    try {
      await first.query("BEGIN");
      await first.query(REVERSAL, ["rv-wl-x3", "wl-x3"]);
      expect(await grantedAdvisory(firstPid)).toBe(1);
      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '8s'");
      pending = second.query(REVERSAL, ["rv-wl-x4", "wl-x4"]).catch((error: unknown) => error);
      await untilWaiting(secondPid);
      await first.query("ROLLBACK");
      expect(await grantedAdvisory(firstPid)).toBe(0);
      const outcome = await pending;
      if (outcome instanceof Error) throw outcome;
      await second.query("COMMIT");
      expect(await grantedAdvisory(secondPid)).toBe(0);
      expect(await reversalCount("rv-wl-x3")).toBe(0);
      expect(await reversalCount("rv-wl-x4")).toBe(1);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await pending;
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  }, 20_000);

  it("still stores an ordinary reversal, and commit clears the lock", async () => {
    await deal(pool, "wl-flow", "customer-flow");
    await pool.query(REVERSAL, ["rv-wl-flow", "wl-flow"]);
    expect(await reversalCount("rv-wl-flow")).toBe(1);
    const session = await pool.connect();
    const sessionPid = await pidOf(session);
    try {
      await session.query("BEGIN");
      await session.query(LOCK, [TENANT, ENTITY, BRANCH, "customer-flow"]);
      expect(await grantedAdvisory(sessionPid)).toBe(1);
      await session.query("COMMIT");
      expect(await grantedAdvisory(sessionPid)).toBe(0);
      await session.query("BEGIN");
      await session.query(LOCK, [TENANT, ENTITY, BRANCH, "customer-flow"]);
      expect(await grantedAdvisory(sessionPid)).toBe(1);
      await session.query("ROLLBACK");
      expect(await grantedAdvisory(sessionPid)).toBe(0);
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
  }, 20_000);

  it("does not lock a new deal, and leaves the append-only guards", async () => {
    const session = await pool.connect();
    const sessionPid = await pidOf(session);
    try {
      await session.query("BEGIN");
      await deal(session, "wl-book", "customer-book");
      expect(await grantedAdvisory(sessionPid)).toBe(0);
      await session.query("COMMIT");
    } finally {
      await session.query("ROLLBACK").catch(() => undefined);
      session.release();
    }
    const guards = await pool.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal
          AND t.tgname IN (
            'ledger_tx_immutable',
            'ledger_audit_immutable',
            'ledger_report_filings_sealed'
          )
        ORDER BY t.tgname`,
    );
    expect(guards.rows.map((row) => row.tgname)).toEqual([
      "ledger_audit_immutable",
      "ledger_report_filings_sealed",
      "ledger_tx_immutable",
    ]);
    const appendOnly = await pool.query(
      "SELECT 1 FROM pg_proc WHERE proname = 'ledger_append_only'",
    );
    expect(appendOnly.rowCount).toBeGreaterThan(0);
    const locked = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal
          AND p.proname = 'ledger_reversal_watch_lock'
        ORDER BY c.relname`,
    );
    expect(locked.rows.map((row) => row.relname)).toEqual(["ledger_reversals"]);
  }, 20_000);
});
