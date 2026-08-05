/* ============================================================
   THE CURRENCIES A DESK ACTUALLY TRADES.

   The ledger capped every desk in the product at four of them. Not by
   schema — `ledger_till_balances.currency` has always been a `char(3)` —
   but by five copies of `z.enum(["CAD", "USD", "EUR", "GBP"])` in
   `server/src/ledger/routes.ts` and a matching `type Currency` union in
   five service files. A placeholder from the pilot that quietly became a
   product boundary.

   It is the most expensive line in the codebase for a shop like the ones
   this is built for. Remittance is the biggest thing most currency desks
   do; the corridors seeded in this product are the Philippines, India,
   China, Mexico and the UAE; and a Toronto desk running the Philippine
   corridor could not put a single peso into a till, count one at close,
   or exchange one. The request was refused at the route.

   ---- WHERE THE ANSWER COMES FROM ----

   Onboarding already asks. Screen 11 is "Currencies", it is required,
   and the answer already publishes the branch's opening rate board
   (server/src/rates/starting-board.ts). It was simply never written
   anywhere the LEDGER could read, so the ledger kept its own opinion.

   `traded_currencies` is that answer, at the legal entity — the same
   place `cost_method` and the threshold overrides live, and for the same
   reason: it is a decision about how this business operates, not about
   one counter. NULL is not an empty set. It means "nobody has stated
   one", and the resolver falls back to what the branch's board is
   already quoting, so every desk that exists today keeps trading exactly
   what it trades today and nothing needs backfilling by hand.

   ---- WHAT IS NOT HERE ----

   Minor units are NOT a column. They are ISO 4217 — JPY has none, KWD
   has three, and that is a fact about the currency and not about the
   desk. A column would be a place for a desk to be wrong about the yen.
   They live in server/src/ledger/currencies.ts, which also states why
   three-decimal currencies are refused rather than silently truncated
   into these `numeric(24,2)` columns.
   ============================================================ */

ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS traded_currencies text[];

/* Every code is three uppercase letters, and a stated set is never
   empty. Enforced here as well as in the resolver, because a constraint
   is the only one of the two that still holds when somebody writes the
   row from psql.

   Written against the array's TEXT form — `{USD,PHP}` — because a CHECK
   constraint may not contain a subquery, which rules out the `unnest`
   this would otherwise be. The cast is total and its output format is
   fixed, so the regex is exact rather than approximate: `{}` fails it,
   which is deliberate. NULL means nobody has stated a set and the
   resolver falls back to the board; an empty array would mean this desk
   trades nothing, which is not a thing anybody means. */
ALTER TABLE legal_entities DROP CONSTRAINT IF EXISTS legal_entities_traded_currencies_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_traded_currencies_check
  CHECK (
    traded_currencies IS NULL
    OR traded_currencies::text ~ '^\{[A-Z]{3}(,[A-Z]{3})*\}$'
  );
