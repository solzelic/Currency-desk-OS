/* How stale a rate board may be before the desk stops quoting.
   A market-sync board is capped at 70 minutes. The window uses the
   clamped sync gap, so RATES_SYNC_MINUTES=15 does not close it at 25
   minutes. A hand-published board while the sync is off is capped at
   12 hours. Env can only shorten either cap. */
import { afterEach, describe, expect, it } from "vitest";
import {
  boardMaxAgeSeconds,
  MANUAL_BOARD_MAX_AGE_SECONDS,
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

  it("keeps a 40 minute board quotable when the sync env is 15 minutes", () => {
    process.env.RATES_SYNC_MINUTES = "15";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 40 * MINUTE, NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW)).toBe(true);
  });

  it("lets a shorter setting tighten the window", () => {
    process.env.RATE_BOARD_MAX_AGE_SECONDS = String(30 * 60);
    expect(boardMaxAgeSeconds()).toBe(30 * 60);
    expect(ratePublicationIsStale(NOW - 30 * MINUTE, NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - 30 * MINUTE - 1, NOW)).toBe(true);

    delete process.env.RATE_BOARD_MAX_AGE_SECONDS;
    process.env.RATES_SYNC_MINUTES = "30";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 40 * MINUTE, NOW)).toBe(false);
  });

  it("keeps a hand published board for 12 hours when sync is off", () => {
    process.env.RATES_SYNC = "off";
    const manual = { publishedBy: "m.costa" };
    expect(MANUAL_BOARD_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    expect(boardMaxAgeSeconds(manual)).toBe(MANUAL_BOARD_MAX_AGE_SECONDS);
    expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, manual)).toBe(false);
    expect(ratePublicationIsStale(NOW - 12 * 60 * MINUTE - 5_000, NOW, manual)).toBe(true);
    const synced = { marketSnapshotId: "snap-1", publishedBy: "market-sync (test)" };
    expect(boardMaxAgeSeconds(synced)).toBe(70 * 60);
    expect(boardMaxAgeSeconds({ published_by: "market-sync (open-er-api)" })).toBe(70 * 60);
    expect(boardMaxAgeSeconds({ market_snapshot_id: "snap-1" })).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, synced)).toBe(true);
  });

  it("holds both caps when RATE_BOARD_MAX_AGE_SECONDS is 1e12", () => {
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "1e12";
    const synced = { marketSnapshotId: "snap-1", publishedBy: "market-sync (test)" };
    expect(boardMaxAgeSeconds(synced)).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, synced)).toBe(true);
    process.env.RATES_SYNC = "off";
    const manual = { publishedBy: "m.costa" };
    expect(boardMaxAgeSeconds(manual)).toBe(12 * 60 * 60);
    expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, manual)).toBe(false);
    expect(ratePublicationIsStale(NOW - 12 * 60 * MINUTE - 5_000, NOW, manual)).toBe(true);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, synced)).toBe(true);
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
    process.env.RATES_SYNC = "off";
    expect(boardMaxAgeSeconds({ publishedBy: "m.costa" })).toBe(300);
  });
});
