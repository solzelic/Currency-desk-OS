/* ============================================================
   Running it again when the database says to.

   Every money path in this product runs at SERIALIZABLE, which is the
   right isolation for a book: it refuses anything that would only have
   been correct if two transactions had not overlapped. The contract is
   that the caller RETRIES what it aborts. Nothing did.

   So a teller topping up a drawer while the screen behind them refreshed
   its balances got `500 · Unexpected server error` on a movement that was
   never wrong, and two tills posting at the same moment would race the
   same way. It was invisible for months because a test fixture was firing
   a request and ignoring the response — the 500 went into a variable
   nobody read.

   These tests hold the two halves of the fix. The retry itself, and the
   rule that a genuine abort is never dressed up as a fault.
   ============================================================ */
import { describe, expect, it } from "vitest";
import { isRetryable, withSerializationRetry } from "../src/ledger/retry.js";

/** What `pg` throws when PostgreSQL aborts a serializable transaction. */
const pgError = (code: string) =>
  Object.assign(new Error("could not serialize access due to concurrent update"), {
    code,
  });

describe("what counts as 'run it again'", () => {
  it("knows the two codes that mean contention", () => {
    expect(isRetryable(pgError("40001"))).toBe(true);  // serialization_failure
    expect(isRetryable(pgError("40P01"))).toBe(true);  // deadlock_detected
  });

  it("does not mistake a real fault for contention", () => {
    /* The dangerous direction. Retrying a constraint violation or a
       syntax error six times changes nothing except how long the teller
       waits for the same refusal — and worse, it would hide a genuine
       defect behind a delay. */
    expect(isRetryable(pgError("23505"))).toBe(false);  // unique_violation
    expect(isRetryable(pgError("23503"))).toBe(false);  // foreign_key_violation
    expect(isRetryable(pgError("42883"))).toBe(false);  // undefined_function
    expect(isRetryable(new Error("something else"))).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable("40001")).toBe(false);           // a string, not an error
  });
});

describe("retrying a serialized transaction", () => {
  it("gets through once the contention clears", async () => {
    let attempts = 0;
    const result = await withSerializationRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw pgError("40001");
      return "posted";
    });
    expect(result).toBe("posted");
    expect(attempts).toBe(3);
  });

  it("does not retry something that was actually wrong", async () => {
    let attempts = 0;
    await expect(
      withSerializationRetry(async () => {
        attempts += 1;
        throw pgError("23505");
      }),
    ).rejects.toMatchObject({ code: "23505" });
    // once, not six times
    expect(attempts).toBe(1);
  });

  it("gives up rather than grinding, and says what it gave up on", async () => {
    /* Bounded on purpose. A desk that cannot get a movement through in six
       attempts is contending on something structural, and "the ledger is
       busy, try again" is more honest than holding the connection open.
       The error that comes back is still the database's own, so the route
       can recognise it and answer LEDGER_BUSY rather than 500. */
    let attempts = 0;
    await expect(
      withSerializationRetry(async () => {
        attempts += 1;
        throw pgError("40001");
      }, 3),
    ).rejects.toMatchObject({ code: "40001" });
    expect(attempts).toBe(3);
  });

  it("runs the caller's own transaction each time, not a reused one", async () => {
    /* A rolled-back transaction cannot be reused, which is why this wraps
       whole operations and never pieces of them. If a caller ever opened
       its connection OUTSIDE the retried function, the second attempt
       would run on a dead transaction — so each attempt has to do its own
       setup. This asserts the shape that makes that true. */
    const opened: number[] = [];
    let attempts = 0;
    await withSerializationRetry(async () => {
      attempts += 1;
      opened.push(attempts);        // stands in for pool.connect() + BEGIN
      if (attempts < 2) throw pgError("40001");
      return null;
    });
    expect(opened).toEqual([1, 2]);
  });
});
