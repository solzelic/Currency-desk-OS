/* The background rates check used to read market_rates every 15 minutes.
   The gap is 60 minutes to 24 hours. RATES_SYNC_MINUTES can only lengthen
   it. Junk, Infinity, and a huge value clamp. A delay past the 32-bit
   timer limit must not become 1 ms. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Db } from "../src/db/index.js";
import type { MarketPull } from "../src/rates/market.js";
import {
  nextRatesSyncDelayMs,
  ratesSyncGateMs,
  ratesSyncIntervalMs,
  ratesSyncTimerDelayMs,
  RATES_SYNC_FAILURE_RETRY_MS,
  RATES_SYNC_MAX_MS,
  RATES_SYNC_MIN_MS,
} from "../src/rates/sync-interval.js";
import { startRatesSync } from "../src/rates/sync-schedule.js";
import { boardMaxAgeSeconds, ratePublicationIsStale } from "../src/quotes/service.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const LIMIT = 2_147_483_647;
const NOW = 1_700_000_000_000;
const KEYS = ["RATE_BOARD_MAX_AGE_SECONDS", "RATES_SYNC", "RATES_SYNC_MINUTES"] as const;
const pull: MarketPull = { provider: "test", providerTimestamp: null, mids: { USD: 1.4 } };

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function windowMs() {
  return boardMaxAgeSeconds() * 1000;
}

describe("rates sync gap", () => {
  it("lengthens from 60 minutes and clamps junk, Infinity, and overflow", () => {
    expect(RATES_SYNC_MIN_MS).toBe(HOUR);
    expect(RATES_SYNC_MAX_MS).toBe(DAY);
    expect(RATES_SYNC_MAX_MS).toBeLessThanOrEqual(LIMIT);
    for (const raw of [undefined, "", "nope", "0", "1", "15", "59", "-4"]) {
      expect(ratesSyncIntervalMs(raw)).toBe(HOUR);
    }
    expect(ratesSyncIntervalMs("60")).toBe(HOUR);
    expect(ratesSyncIntervalMs("61")).toBe(61 * 60 * 1000);
    expect(ratesSyncIntervalMs("90.9")).toBe(90 * 60 * 1000);
    expect(ratesSyncIntervalMs("360")).toBe(6 * HOUR);
    for (const raw of ["1440", "1441", "1e9", "1e20", "1e309", "Infinity", "99999"]) {
      expect(ratesSyncIntervalMs(raw)).toBe(DAY);
    }
    expect(ratesSyncTimerDelayMs(1e12)).toBe(DAY);
    expect(ratesSyncTimerDelayMs(Number.POSITIVE_INFINITY)).toBe(DAY);
    expect(ratesSyncTimerDelayMs(Number.NaN)).toBe(HOUR);
    expect(ratesSyncTimerDelayMs(0)).toBe(HOUR);
    expect(ratesSyncTimerDelayMs(10 * 60 * 1000)).toBe(10 * 60 * 1000);
    expect(ratesSyncTimerDelayMs(1e12)).toBeLessThanOrEqual(LIMIT);
    expect(ratesSyncGateMs(HOUR)).toBe(HOUR - 60_000);
    expect(nextRatesSyncDelayMs(0, HOUR)).toBe(HOUR - 60_000);
    expect(nextRatesSyncDelayMs(30 * 60 * 1000, HOUR)).toBe(29 * 60 * 1000);
    expect(nextRatesSyncDelayMs(HOUR, HOUR)).toBe(HOUR);
    expect(nextRatesSyncDelayMs(Number.POSITIVE_INFINITY, HOUR)).toBe(HOUR);
    expect(nextRatesSyncDelayMs(0, 15 * 60 * 1000)).toBe(HOUR - 60_000);
    expect(RATES_SYNC_FAILURE_RETRY_MS).toBe(10 * 60 * 1000);
  });
});

describe("quote staleness follows the clamped gap", () => {
  it("trips just past the window, including overflow", () => {
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - windowMs(), NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - windowMs() - 1, NOW)).toBe(true);

    process.env.RATES_SYNC_MINUTES = "15";
    expect(boardMaxAgeSeconds()).toBe(70 * 60);
    expect(ratePublicationIsStale(NOW - windowMs() - 1, NOW)).toBe(true);

    process.env.RATES_SYNC_MINUTES = "360";
    expect(boardMaxAgeSeconds()).toBe(360 * 60 + 10 * 60);
    expect(ratePublicationIsStale(NOW - windowMs(), NOW)).toBe(false);
    expect(ratePublicationIsStale(NOW - windowMs() - 1, NOW)).toBe(true);

    for (const raw of ["1e9", "1e20", "Infinity", "99999"]) {
      process.env.RATES_SYNC_MINUTES = raw;
      expect(boardMaxAgeSeconds()).toBe(1440 * 60 + 10 * 60);
      expect(Number.isFinite(boardMaxAgeSeconds())).toBe(true);
      expect(ratePublicationIsStale(NOW - windowMs() - 1, NOW)).toBe(true);
    }

    process.env.RATES_SYNC_MINUTES = "1440";
    process.env.RATE_BOARD_MAX_AGE_SECONDS = "300";
    expect(boardMaxAgeSeconds()).toBe(300);
    expect(ratePublicationIsStale(NOW - 300_001, NOW)).toBe(true);

    delete process.env.RATE_BOARD_MAX_AGE_SECONDS;
    process.env.RATES_SYNC = "off";
    process.env.RATES_SYNC_MINUTES = "1e9";
    expect(boardMaxAgeSeconds()).toBe(12 * 60 * 60);
    expect(ratePublicationIsStale(NOW - 12 * 60 * 60 * 1000 - 1, NOW)).toBe(true);
    expect(ratePublicationIsStale(NOW - HOUR, NOW)).toBe(false);
  });
});

function chain(limit: () => Promise<unknown>) {
  return { select: () => ({ from: () => ({ orderBy: () => ({ limit }) }) }) };
}

describe("rates sync timer", () => {
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops) stop();
    stops.length = 0;
  });

  async function boot() {
    await vi.advanceTimersByTimeAsync(0);
  }

  it("does not read on a 15 minute timer, and caps 1e12 at 24 hours", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    let pulls = 0;
    const db = chain(async () => {
      reads += 1;
      return [{ fetchedAt: new Date() }];
    }) as unknown as Db;
    const fetcher = async () => {
      pulls += 1;
      return pull;
    };
    stops.push(startRatesSync(db, "br-yorkville", 15 * 60 * 1000, fetcher));
    await boot();
    expect(reads).toBe(1);
    expect(pulls).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(ratesSyncGateMs(HOUR) - 15 * 60 * 1000);
    expect(reads).toBe(2);
    expect(pulls).toBe(0);
    stops.pop()?.();

    reads = 0;
    stops.push(startRatesSync(db, "br-yorkville", 1e12, fetcher));
    await boot();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(ratesSyncGateMs(DAY) - 1000);
    expect(reads).toBe(2);
    expect(pulls).toBe(0);
  });

  it("retries a failure inside the headroom, and still inserts when the snapshot is due", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    let writes = 0;
    let pulls = 0;
    const db = {
      ...chain(async () => {
        reads += 1;
        return [{ fetchedAt: new Date(Date.now() - 2 * HOUR) }];
      }),
      insert() {
        writes += 1;
        throw new Error("write reached");
      },
    } as unknown as Db;

    stops.push(startRatesSync(db, "br-yorkville", HOUR, async () => {
      pulls += 1;
      throw new Error("provider exploded");
    }));
    await boot();
    expect(pulls).toBe(1);
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pulls).toBe(1);
    await vi.advanceTimersByTimeAsync(RATES_SYNC_FAILURE_RETRY_MS - 1000);
    expect(pulls).toBe(2);
    stops.pop()?.();

    pulls = 0;
    writes = 0;
    reads = 0;
    stops.push(startRatesSync(db, "br-yorkville", HOUR, async () => {
      pulls += 1;
      return pull;
    }));
    await boot();
    expect(reads).toBe(1);
    expect(pulls).toBe(1);
    expect(writes).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toBe(1);
  });

  it("after a successful pull, waits out the new gap instead of the old age", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    const sync = async () => {
      calls += 1;
      return { ok: true, skipped: false, detail: "board published", ageMs: 2 * HOUR };
    };
    stops.push(startRatesSync({} as Db, "br-yorkville", HOUR, undefined, sync));
    await boot();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(ratesSyncGateMs(HOUR) - 15 * 60 * 1000);
    expect(calls).toBe(2);
  });

  it("waits out a database error instead of looping", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    const db = chain(async () => {
      reads += 1;
      throw new Error("db down");
    }) as unknown as Db;
    stops.push(startRatesSync(db, "br-yorkville", HOUR));
    await boot();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(RATES_SYNC_FAILURE_RETRY_MS - 1000);
    expect(reads).toBe(2);
  });

  it("boot does not schedule the 15 minute rates check", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const listen = src.slice(src.indexOf("export async function listenServer"));
    expect(listen).toContain("startRatesSync");
    expect(listen).toContain('RATES_SYNC !== "off"');
    expect(listen).not.toMatch(/15\s*\*\s*60\s*\*\s*1000/);
    expect(listen).not.toContain("setInterval");
  });
});
