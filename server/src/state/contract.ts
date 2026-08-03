/* ============================================================
   The desk-state document — its size, and what we promise about it.

   WHY THIS FILE EXISTS

   A desk's working state is one JSON document per tenant, written whole by
   the browser every few seconds. Two numbers govern it: the size we promise
   a desk, and the size at which the server stops reading. They were in two
   different places — one of them implicit — and they disagreed.

   THE BUG THIS CAME FROM

   `routes/tenantState.ts` guarded at 4 MB and said so. No body limit was
   configured anywhere, so Fastify's 1 MiB default rejected first and the
   guard could never run. Probed against a running server:

       0.5 MB → 200
       1.5 MB → 413 Payload Too Large
       3.0 MB → 413 Payload Too Large

   The real ceiling was a quarter of the documented one. Worse, the client
   only advanced its "saved" marker on a 2xx, so a desk that outgrew 1 MiB
   retried the same doomed payload every four seconds forever — no log, no
   banner, nothing. Silent, permanent, unrecoverable data loss.

   HOW THE TWO NUMBERS RELATE

   The guard is BELOW the hard stop on purpose. Fastify's refusal is generic
   and gives the client nothing to act on; ours names the problem and says
   how big the document actually got. The headroom between them exists so
   ours is the one that speaks, and the hard stop is only there to keep an
   absurd body from being parsed into memory at all.

   Both numbers live here so a change to one is a change to the other in the
   same edit.
   ============================================================ */

/** What we promise a desk. Unchanged from the number the code always
    claimed — a desk sitting just under the old, real 1 MiB ceiling must not
    regress the day this lands. Promotion of clients and transactions into
    tables (see docs/ARCHITECTURE.md §3) shrinks the document well before
    anybody meets this. */
export const MAX_STATE_BYTES = 4 * 1024 * 1024;

/** Where Fastify stops reading. Above the guard, so the guard answers first
    with something actionable. */
export const BODY_LIMIT_BYTES = MAX_STATE_BYTES + 256 * 1024;

/** Warn a desk while it can still be helped rather than at the wall. At
    four fifths there is room for weeks of trading, which is the point:
    somebody should hear about this over a coffee, not mid-transaction. */
export const WARN_AT_BYTES = Math.floor(MAX_STATE_BYTES * 0.8);

/** The refusal, in one shape so every caller reads the same words. */
export function tooLarge(bytes: number): {
  error: string;
  detail: string;
  bytes: number;
  limit: number;
} {
  return {
    error: "state_too_large",
    detail:
      `This desk's saved state is ${mb(bytes)} MB, over the ${mb(MAX_STATE_BYTES)} MB limit. ` +
      `Nothing was saved. Contact CurrencyDesk — this needs looking at, not retrying.`,
    bytes,
    limit: MAX_STATE_BYTES,
  };
}

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
