import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, type Db } from "../db/index.js";

/** Bounds provider waiting, not arbitrary SQL or a frozen event loop. */
export const MARKET_PULL_TIMEOUT_MS = 10_000;

/** Own only this sync's checkout. Drizzle's pool transaction removes the idle
 * client error listener and releases only after BEGIN succeeds. Owning the
 * checkout here covers BEGIN, provider waiting, COMMIT and failed ROLLBACK,
 * without changing other pool users or leaving permanent listeners behind. */
export async function withSyncTransaction<T>(
  db: Db, work: (tx: Db, controller: AbortController) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const run = (connection: Db) => connection.transaction(async (tx) => {
    controller.signal.throwIfAborted();
    const result = await work(tx, controller);
    controller.signal.throwIfAborted();
    return result;
  }, { isolationLevel: "read committed" });

  // $client is drizzle's public driver handle. Db also accepts transactions,
  // which have no $client; they keep their existing transaction/savepoint path.
  const driver = "$client" in db ? db.$client : undefined;
  if (!(driver instanceof pg.Pool)) return run(db);

  const client = await driver.connect();
  const onError = () => controller.abort(new Error("market sync database connection lost"));
  client.on("error", onError);
  let discard = false;
  try {
    // A client-backed Drizzle transaction never checks out another connection.
    return await run(drizzle(client, { schema }));
  } catch (error) {
    // Also discard on BEGIN/ROLLBACK failure: an uncertain transaction must
    // never be returned to the pool as a healthy idle connection.
    discard = true;
    // A dead client can make Drizzle's rollback throw too. Preserve the
    // initiating disconnect/deadline instead of reporting only rollback SQL.
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    // release installs the pool's idle listener (or ends a discarded client)
    // synchronously, before ours is removed.
    client.release(discard);
    client.removeListener("error", onError);
  }
}

/** Race only the provider promise, never a transaction that could keep writing
 * after rollback. Even a fetcher ignoring abort cannot hold the database past
 * the deadline or publish its late result. The real fetch uses the signal to
 * cancel network/body work and must not start fallback after cancellation. */
export async function boundedMarketPull<T>(
  fetcher: (signal?: AbortSignal) => Promise<T>, controller: AbortController,
): Promise<T> {
  const { signal } = controller;
  signal.throwIfAborted();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("market provider timed out")), MARKET_PULL_TIMEOUT_MS);
  try {
    // Register rejection handling even if the provider eventually rejects
    // after the deadline. No write continuation is attached to that promise.
    return await Promise.race([Promise.resolve().then(() => fetcher(signal)), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
