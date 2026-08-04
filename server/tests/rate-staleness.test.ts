/* ============================================================
   How stale a rate board may be before the desk stops quoting.

   This check shipped in contradiction with the thing it depends on. The
   market sync republishes the board every RATES_SYNC_MINUTES — 60 by
   default — and the tolerance was a flat 300 seconds. On the shipped
   defaults a desk could quote for five minutes an hour and was refused for
   the other fifty-five, with "Rate publication is stale." and nothing a
   teller could do about it.

   Nothing tested it, which is how two numbers that must agree came to
   disagree. The invariant is not a particular figure: it is that the
   tolerance is never shorter than the refresh cadence, because any such
   number guarantees a window in which no deal can be priced.
   ============================================================ */
import { afterEach, describe, expect, it } from "vitest";
import { boardMaxAgeSeconds } from "../src/quotes/service.js";

const KEYS = [
  "RATE_BOARD_MAX_AGE_SECONDS",
  "RATES_SYNC",
  "RATES_SYNC_MINUTES",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("how old a board may be", () => {
  it("outlasts the refresh that keeps it fresh", () => {
    // the shipped defaults, which is the case that was broken
    expect(boardMaxAgeSeconds()).toBeGreaterThan(60 * 60);
  });

  it("tracks the sync interval rather than a number chosen beside it", () => {
    process.env.RATES_SYNC_MINUTES = "15";
    const quarterly = boardMaxAgeSeconds();
    expect(quarterly).toBeGreaterThan(15 * 60);

    /* A desk that pulls rates four times a day must not inherit a tolerance
       set for one that pulls every fifteen minutes. This is the whole point
       of deriving it: the two cannot drift apart again. */
    process.env.RATES_SYNC_MINUTES = "360";
    expect(boardMaxAgeSeconds()).toBeGreaterThan(360 * 60);
    expect(boardMaxAgeSeconds()).toBeGreaterThan(quarterly);
  });

  it("gives a manually published board the working day", () => {
    /* Nothing refreshes the board but a person. A manager who publishes at
       open should be able to trade the shift on it — but not on
       yesterday's, which is what the check exists to refuse. */
    process.env.RATES_SYNC = "off";
    expect(boardMaxAgeSeconds()).toBeGreaterThanOrEqual(8 * 60 * 60);
    expect(boardMaxAgeSeconds()).toBeLessThan(24 * 60 * 60);
  });

  it("still lets a desk say exactly what it wants", () => {
    process.env.RATES_SYNC_MINUTES = "60";
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "300";
    // a desk that genuinely wants five minutes gets five minutes
    expect(boardMaxAgeSeconds()).toBe(300);
  });
});
