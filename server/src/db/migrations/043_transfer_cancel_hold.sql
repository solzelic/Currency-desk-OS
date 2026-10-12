-- Hold is a status on the obligation, decided by the server. A click in
-- the browser does not count. Cancelling a send records that a manager
-- checked with the partner and was told it has not been paid out.
--
-- Live schema: ledger_obligations and ledger_reversals are created by
-- 001_ledger and 018_obligations. They are not in the Drizzle DDL, so a
-- database that is already running receives this only when the migration
-- applies.
--
-- Backfill: do not invent paid_out_at for a transfer that was marked
-- paid only in the browser before paid_out_at existed. Those rows stay
-- open, with paid_out_at null. Cancelling one still requires the
-- recorded partner confirmation. This file does not update any row.
ALTER TABLE ledger_reversals
  ADD COLUMN IF NOT EXISTS partner_confirmed_not_paid boolean NOT NULL DEFAULT false;

ALTER TABLE ledger_obligations DROP CONSTRAINT IF EXISTS ledger_obligations_status_check;

ALTER TABLE ledger_obligations
  ADD CONSTRAINT ledger_obligations_status_check
  CHECK (status IN ('open', 'settled', 'written_off', 'reversed', 'held'));
