-- The unrounded expected, saved next to the variance on a new count.
--
-- variance_amount on a new row is the counted amount minus roundTo of
-- that expected. expected_amount stays the balance the ledger stored.
-- stored_expected_amount is that same unrounded figure.
--
-- Rows written before this column existed keep stored_expected_amount
-- NULL. This does not backfill them, does not write 0, and does not
-- recalculate variance_amount. The count row is already append-only
-- (migration 006), so the value cannot be updated after insert.
ALTER TABLE ledger_till_counts
  ADD COLUMN stored_expected_amount numeric(24,2);

ALTER TABLE ledger_till_counts
  DROP CONSTRAINT IF EXISTS ledger_till_counts_stored_expected_amount_check;

ALTER TABLE ledger_till_counts
  ADD CONSTRAINT ledger_till_counts_stored_expected_amount_check
  CHECK (stored_expected_amount IS NULL OR stored_expected_amount >= 0);
