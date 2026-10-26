import type { Db } from "../db/index.js";
import { syncMarketRatesIfStale, type MarketPull } from "./market.js";
import {
  clampRatesSyncGapMs,
  nextRatesSyncDelayMs,
  ratesSyncGateMs,
  ratesSyncTimerDelayMs,
  RATES_SYNC_FAILURE_RETRY_MS,
} from "./sync-interval.js";

type SyncFn = typeof syncMarketRatesIfStale;

/** Pull when the newest snapshot is older than the gap. A fresh snapshot
    waits until it is due. A failed pull tries again after 10 minutes.
    The delay is clamped so a huge number cannot become a 1 ms timer. */
export function startRatesSync(
  db: Db,
  branchId: string,
  gapMs: number,
  fetcher?: () => Promise<MarketPull>,
  sync: SyncFn = syncMarketRatesIfStale,
): () => void {
  const gap = clampRatesSyncGapMs(gapMs);
  const gate = ratesSyncGateMs(gap);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    const ms = ratesSyncTimerDelayMs(delayMs);
    timer = setTimeout(() => {
      void tick();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    let delay = gap;
    try {
      const result = await sync(db, branchId, gate, fetcher);
      if (stopped) return;
      console.log(`[rates-sync] ${result.skipped ? "skip" : result.ok ? "ok" : "FAILED"} - ${result.detail}`);
      if (result.skipped) delay = nextRatesSyncDelayMs(result.ageMs, gap);
      else if (!result.ok) delay = RATES_SYNC_FAILURE_RETRY_MS;
      else delay = nextRatesSyncDelayMs(0, gap);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      console.log(`[rates-sync] FAILED - ${message}`);
      delay = RATES_SYNC_FAILURE_RETRY_MS;
    }
    schedule(delay);
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
