/* ============================================================
   Retrying a transaction the database asked us to run again.

   Every money movement here runs at SERIALIZABLE, which is the right
   isolation for a book: it refuses anything that would only have been
   correct if the two transactions had not overlapped. The price is that
   PostgreSQL will sometimes abort a perfectly good transaction with
   40001, "could not serialize access due to concurrent update", and the
   contract is that the caller RETRIES it.

   We were not retrying. The abort travelled up as an unhandled database
   error and the route answered `500 INTERNAL_ERROR · Unexpected server
   error`, which is a lie twice over: nothing unexpected happened, and
   nothing was wrong with the request. A teller topping up a drawer while
   the screen behind them refreshed its balances got it; a second till
   posting at the same moment as the first would get it; and the only
   guidance on screen was to try something that had never actually failed.

   It surfaced because a test fixture began asserting on a call it used to
   fire and forget — which is its own lesson about fixtures.

   Safe to retry because a serialization failure means the transaction was
   rolled back in full: nothing was written, so there is nothing to undo.
   And every operation wrapped here is keyed by an idempotency key, so a
   retry that races a genuine duplicate still lands on the duplicate path
   rather than posting twice.

   Bounded: six attempts. The wait doubles each time, starting at 25ms,
   and then adds a spread as wide as that wait. A fixed delay put every
   loser of the same wave on the same millisecond, and a handover of
   twenty-four tills was still aborted on the sixth try. If a movement
   still cannot get through, the caller gets a clear error — the ledger
   is busy, nothing was posted — and the database code stays on it so
   the route can answer LEDGER_BUSY.
   ============================================================ */

/** PostgreSQL codes that mean "run it again", not "it was wrong". */
const RETRYABLE = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

export const isRetryable = (error: unknown): boolean =>
  !!error &&
  typeof error === "object" &&
  RETRYABLE.has(String((error as { code?: unknown }).code ?? ""));

/* 25, 50, 100, 200, 400. Capped so a longer try-count cannot sleep for
   seconds. The spread is as wide as the wait: two writers that aborted
   together draw different delays and one of them commits first. */
const retryWaitMs = (attempt: number): number => {
  const exponential = Math.min(25 * 2 ** attempt, 800);
  const spread = Math.floor(Math.random() * exponential);
  return exponential + spread;
};

const exhaustedRetry = (tries: number, cause: unknown): Error => {
  const code = String((cause as { code?: unknown } | null)?.code ?? "40001");
  return Object.assign(
    new Error(
      `The ledger is busy after ${tries} attempts. Nothing was posted. Try again.`,
      cause instanceof Error ? { cause } : undefined,
    ),
    { code },
  );
};

/**
 * Run `attempt` until it succeeds, it fails for a reason that is not the
 * database asking us to try again, or we run out of tries.
 *
 * The caller's function must open and close its OWN transaction — a
 * rolled-back one cannot be reused — so this wraps whole operations, never
 * pieces of them.
 */
export async function withSerializationRetry<T>(
  attempt: () => Promise<T>,
  tries = 6,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      last = error;
      if (i < tries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryWaitMs(i)));
      }
    }
  }
  throw exhaustedRetry(tries, last);
}
