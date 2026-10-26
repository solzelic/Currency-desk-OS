/** How often the background market sync may touch the database.

    Neon suspends after 5 minutes with no queries. setTimeout stores the
    delay in a 32-bit signed integer, and a larger value fires in 1 ms.
    The gap is exactly 60 minutes. RATES_SYNC_MINUTES cannot change it.
    A delay past that integer limit is capped at 24 hours. */

const MINUTE_MS = 60_000;

export const RATES_SYNC_MIN_MINUTES = 60;
export const RATES_SYNC_MAX_MINUTES = 24 * 60;
export const RATES_SYNC_MIN_MS = RATES_SYNC_MIN_MINUTES * MINUTE_MS;
export const RATES_SYNC_MAX_MS = RATES_SYNC_MAX_MINUTES * MINUTE_MS;

/** Quote window past one gap. A missed pull is tried again inside this. */
export const RATES_SYNC_HEADROOM_SECONDS = 10 * 60;
export const RATES_SYNC_FAILURE_RETRY_MS = RATES_SYNC_HEADROOM_SECONDS * 1000;

/** `RATES_SYNC_MINUTES`. Every value is 60 minutes. */
export function ratesSyncIntervalMs(_rawMinutes?: string): number {
  return RATES_SYNC_MIN_MS;
}

/** True when a set value is not exactly 60. Unset is the 60 minute default. */
export function ratesSyncMinutesNeedsWarning(raw: string | undefined): boolean {
  if (raw == null || raw === "") return false;
  const minutes = Number(raw);
  return !(Number.isFinite(minutes) && minutes === 60);
}

/** One boot line when the env asks for a gap other than 60 minutes. */
export function warnRatesSyncMinutes(
  raw: string | undefined,
  warn: (message: string) => void = console.warn,
): void {
  if (!ratesSyncMinutesNeedsWarning(raw)) return;
  warn(`[rates-sync] RATES_SYNC_MINUTES=${raw} is ignored. The gap is 60 minutes.`);
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

/** The snapshot is due at the full gap. The cycle is that gap,
    not one minute short of it. */
export function ratesSyncGateMs(gapMs: number): number {
  return clampRatesSyncGapMs(gapMs);
}

/** Wait after a fresh snapshot: the remainder of the gap, not a second
    full gap and not a fixed 15 minutes. A due snapshot waits one full gap. */
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
