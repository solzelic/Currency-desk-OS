/* ============================================================
   How soon somebody may ask for another one-time code.

   WHY THIS IS ONE FILE AND NOT THREE

   Four buttons in this product send a six-digit code: signing in, setting
   a desk up, resetting a forgotten password, and the panel issuing one on
   a call. Each grew its own limit, or none — `/api/auth/login/start` had
   nothing at all, so every press of "Send my code" sent another email.

   The failure is not abuse, it is an ordinary person. A button that looks
   like it did nothing gets pressed again, and then a third time, and the
   inbox fills with codes of which only the last one works — so the one
   they read out is the one that fails.

   THE TWO LIMITS ARE DIFFERENT THINGS

   The hourly cap is about somebody working through a list. The gap is
   about a finger: two minutes between sends, per identity, so a double
   press costs nothing and a stuck retry loop cannot spend the hourly
   budget in ten seconds.

   In memory on purpose. A restart forgetting that somebody asked ninety
   seconds ago is not a security problem — the code itself is in the
   database and still governed by its own expiry and attempt count. Render
   runs one instance; if that changes this moves to a table and nothing
   above it does.
   ============================================================ */

/** Two minutes. Long enough that a mistaken press is free, short enough
    that somebody whose mail is genuinely slow is not stuck. */
export const CODE_GAP_MS = 2 * 60 * 1000;

const lastSent = new Map<string, number>();

/* Old keys are dropped as we go rather than on a timer — this map only
   ever holds people who asked in the last couple of minutes. */
function sweep(now: number): void {
  if (lastSent.size < 500) return;
  for (const [k, t] of lastSent) if (now - t > CODE_GAP_MS) lastSent.delete(k);
}

/**
 * Seconds still to wait before `key` may be sent another code, or 0 when
 * it may go now. Asking does NOT reserve the slot — call `sent()` once the
 * code has actually been issued, so a request that fails for some other
 * reason does not lock them out of retrying.
 */
export function waitBefore(key: string, gapMs = CODE_GAP_MS): number {
  const at = lastSent.get(key);
  if (at === undefined) return 0;
  const left = gapMs - (Date.now() - at);
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** Record that a code just went out to `key`. */
export function sent(key: string): void {
  const now = Date.now();
  sweep(now);
  lastSent.set(key, now);
}

/** The refusal, in the shape every one of these routes answers with. */
export function tooSoon(seconds: number): { error: string; detail: string; retryAfter: number } {
  return {
    error: "too_soon",
    detail: seconds > 60
      ? `A code went out moments ago. You can ask for another in about ${Math.ceil(seconds / 60)} minutes.`
      : `A code went out moments ago. You can ask for another in ${seconds} seconds.`,
    retryAfter: seconds,
  };
}

/** Only for tests, which must not wait two real minutes to prove this. */
export function forget(key?: string): void {
  if (key === undefined) lastSent.clear();
  else lastSent.delete(key);
}
