/** How often the background market sync may touch the database.

    Neon suspends after 5 minutes with no queries. setTimeout stores the
    delay in a 32-bit signed integer, and a larger value fires in 1 ms.
    The gap stays between 60 minutes and 24 hours. A setting can only
    lengthen it. */

const MINUTE_MS = 60_000;

export const RATES_SYNC_MIN_MINUTES = 60;
export const RATES_SYNC_MAX_MINUTES = 24 * 60;
export const RATES_SYNC_MIN_MS = RATES_SYNC_MIN_MINUTES * MINUTE_MS;
export const RATES_SYNC_MAX_MS = RATES_SYNC_MAX_MINUTES * MINUTE_MS;

/** Quote window past one gap. A missed pull is tried again inside this. */
export const RATES_SYNC_HEADROOM_SECONDS = 10 * 60;
export const RATES_SYNC_FAILURE_RETRY_MS = RATES_SYNC_HEADROOM_SECONDS * 1000;

/** `RATES_SYNC_MINUTES`. Missing or junk becomes 60 minutes.
    Below 60 becomes 60. Above 1440, or Infinity, becomes 24 hours. */
export function ratesSyncIntervalMs(rawMinutes: string | undefined): number {
  const minutes = Number(rawMinutes);
  if (minutes === Number.POSITIVE_INFINITY) return RATES_SYNC_MAX_MS;
  if (!Number.isFinite(minutes)) return RATES_SYNC_MIN_MS;
  const clamped = Math.min(
    RATES_SYNC_MAX_MINUTES,
    Math.max(RATES_SYNC_MIN_MINUTES, Math.trunc(minutes)),
  );
  return clamped * MINUTE_MS;
}

/** A gap passed straight in. 15 minutes becomes 60. 1e12 becomes 24 hours. */
export function clampRatesSyncGapMs(gapMs: number): number {
  if (gapMs === Number.POSITIVE_INFINITY) return RATES_SYNC_MAX_MS;
  if (!Number.isFinite(gapMs)) return RATES_SYNC_MIN_MS;
  const ms = Math.trunc(gapMs);
  if (ms >= RATES_SYNC_MAX_MS) return RATES_SYNC_MAX_MS;
  if (ms <= RATES_SYNC_MIN_MS) return RATES_SYNC_MIN_MS;
  return ms;
}

/** One minute inside the gap, and never under half of it. */
export function ratesSyncGateMs(gapMs: number): number {
  const gap = clampRatesSyncGapMs(gapMs);
  return Math.max(gap - MINUTE_MS, gap * 0.5);
}

/** Wait after a fresh snapshot: until the gate, not a second full gap
    and not a fixed 15 minutes. A due snapshot waits one full gap. */
export function nextRatesSyncDelayMs(ageMs: number, gapMs: number): number {
  const gap = clampRatesSyncGapMs(gapMs);
  const gate = ratesSyncGateMs(gap);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= gate) return gap;
  const wait = Math.trunc(gate - ageMs);
  if (wait > RATES_SYNC_MAX_MS) return RATES_SYNC_MAX_MS;
  if (wait < 1) return 1;
  return wait;
}

/** Any delay installed on a timer. A remainder under an hour stays.
    A value that would overflow setTimeout becomes 24 hours. */
export function ratesSyncTimerDelayMs(delayMs: number): number {
  if (delayMs === Number.POSITIVE_INFINITY) return RATES_SYNC_MAX_MS;
  if (!Number.isFinite(delayMs) || delayMs < 1) return RATES_SYNC_MIN_MS;
  const ms = Math.trunc(delayMs);
  if (ms > RATES_SYNC_MAX_MS) return RATES_SYNC_MAX_MS;
  if (ms < 1) return RATES_SYNC_MIN_MS;
  return ms;
}
