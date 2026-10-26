/* How stale a rate board may be before the desk stops quoting.
   The cap is 70 minutes (4200 seconds). It does not grow with the sync
   gap. RATES_SYNC_MINUTES and RATE_BOARD_MAX_AGE_SECONDS can only
   shorten it. Invalid, negative, NaN, Infinity, and 0 fall back to
   70 minutes. */
import { afterEach, describe, expect, it } from "vitest";
import {
  boardMaxAgeSeconds,
  QUOTE_MAX_AGE_SECONDS,
  ratePublicationIsStale,
} from "../src/quotes/service.js";

const KEYS = [
  "RATE_BOARD_MAX_AGE_SECONDS",
  "RATES_SYNC",
  "RATES_SYNC_MINUTES",
] as const;

const NOW = 1_700_000_000_000;
const MINUTE = 60 * 1000;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("how old a board may be", () => {
  it("is 70 minutes when nothing is set", () => {
    expect(QUOTE_MAX_AGE_SECONDS).toBe(70 * 60);
    expect(boardMaxAgeSeconds()).toBe(QUOTE_MAX_AGE_SECONDS);
    expect(ratePublicationIsStale(NOW - 70 * MINUTE, NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("refuses a 71 minute board when the sync gap is 24 hours", () => {
    process.env.RATES_SYNC_MINUTES = "1440";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("refuses a 71 minute board when RATE_BOARD_MAX_AGE_SECONDS is 1e12", () => {
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "1e12";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("lets a shorter setting tighten the window", () => {
    process.env.RATE_BOARD_MAX_AGE_SECONDS = String(30 * 60);
    expect(boardMaxAgeSeconds()).toBe(30 * 60);
    expect(ratePublicationIsStale(NOW - 30 * MINUTE, NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - 30 * MINUTE - 1, NOW)).toBe(true);

    delete process.env.RATE_BOARD_MAX_AGE_SECONDS;
    process.env.RATES_SYNC_MINUTES = "30";
    expect(boardMaxAgeSeconds()).toBe(30 * 60 + 10 * 60);
    expect(boardMaxAgeSeconds()).toBeLessThan(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("does not stretch when the sync is off or the gap is long", () => {
    process.env.RATES_SYNC_MINUTES = "360";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    delete process.env.RATES_SYNC_MINUTES;
    process.env.RATES_SYNC = "off";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("falls back to 70 minutes for junk", () => {
    for (const raw of ["0", "-1", "NaN", "Infinity", "nope"]) {
      process.env.RATE_BOARD_MAX_AGE_SECONDS = raw;
      expect(boardMaxAgeSeconds()).toBe(70 * 60);
      delete process.env.RATE_BOARD_MAX_AGE_SECONDS;
      process.env.RATES_SYNC_MINUTES = raw;
      expect(boardMaxAgeSeconds()).toBe(70 * 60);
      delete process.env.RATES_SYNC_MINUTES;
    }
  });

  it("still lets a desk ask for five minutes", () => {
    process.env.RATES_SYNC_MINUTES = "1440";
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "300";
    expect(boardMaxAgeSeconds()).toBe(300);
  });
});
