/* How stale a rate board may be before the desk stops quoting.
   The cap is 70 minutes. The window uses the clamped sync gap, so
   RATES_SYNC_MINUTES=15 does not close it at 25 minutes. The 12 hour
   window is only when a lookup has confirmed published_by is staff on
   that tenant, and only while the sync is off. */
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

  it("keeps a confirmed staff board for 12 hours when sync is off", () => {
    process.env.RATES_SYNC = "off";
    const staff = { staffPublish: true };
    expect(MANUAL_BOARD_MAX_AGE_SECONDS).toBe(12 * 60 * 60);
    expect(boardMaxAgeSeconds(staff)).toBe(MANUAL_BOARD_MAX_AGE_SECONDS);
    expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, staff)).toBe(false);
    expect(ratePublicationIsStale(NOW - 12 * 60 * MINUTE - 5_000, NOW, staff)).toBe(true);
    for (const board of [
      { publishedBy: "m.costa" },
      { publishedBy: "seed" },
      { publishedBy: "system:provisioning" },
      { marketSnapshotId: "snap-1", publishedBy: "market-sync (test)" },
    ]) {
      expect(boardMaxAgeSeconds(board)).toBe(70 * 60);
      expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, board)).toBe(true);
    }
  });

  it("holds both caps when RATE_BOARD_MAX_AGE_SECONDS is 1e12", () => {
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "1e12";
    const synced = { marketSnapshotId: "snap-1", publishedBy: "market-sync (test)" };
    expect(boardMaxAgeSeconds(synced)).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, synced)).toBe(true);
    process.env.RATES_SYNC = "off";
    const staff = { staffPublish: true };
    expect(boardMaxAgeSeconds(staff)).toBe(12 * 60 * 60);
    expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, staff)).toBe(false);
    expect(ratePublicationIsStale(NOW - 12 * 60 * MINUTE - 5_000, NOW, staff)).toBe(true);
    expect(ratePublicationIsStale(NOW - 71 * MINUTE, NOW, { publishedBy: "seed" })).toBe(true);
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
    expect(boardMaxAgeSeconds({ staffPublish: true })).toBe(300);
  });

  it("shortens a staff board to the stated age and never raises the 12 hour cap", () => {
    process.env.RATES_SYNC = "off";
    const staff = { staffPublish: true };
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "3600";
    expect(boardMaxAgeSeconds(staff)).toBe(3600);
    expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, staff)).toBe(true);
    for (const raw of ["1e12", "NaN", "-5"]) {
      process.env.RATE_BOARD_MAX_AGE_SECONDS = raw;
      expect(boardMaxAgeSeconds(staff)).toBe(MANUAL_BOARD_MAX_AGE_SECONDS);
      expect(ratePublicationIsStale(NOW - 3 * 60 * MINUTE, NOW, staff)).toBe(false);
      expect(ratePublicationIsStale(NOW - 12 * 60 * MINUTE - 5_000, NOW, staff)).toBe(true);
    }
  });
});
