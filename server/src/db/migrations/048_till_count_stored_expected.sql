-- The unrounded expected, saved next to the variance on a count.
--
-- variance_amount is the counted amount minus that expected figure
-- after roundTo (the currency's minor units, half up). expected_amount
-- stays the balance the ledger stored. stored_expected_amount is that
-- same unrounded figure, so a later reader can see what the variance
-- was taken from. A count does not rewrite ledger_till_balances.
--
-- Rows written before this column existed used the raw difference.
-- They are backfilled from expected_amount, which is that stored figure.
ALTER TABLE ledger_till_counts
  ADD COLUMN stored_expected_amount numeric(24,2);

UPDATE ledger_till_counts
   SET stored_expected_amount = expected_amount
 WHERE stored_expected_amount IS NULL;

ALTER TABLE ledger_till_counts
  ALTER COLUMN stored_expected_amount SET NOT NULL;

ALTER TABLE ledger_till_counts
  DROP CONSTRAINT IF EXISTS ledger_till_counts_stored_expected_amount_check;

ALTER TABLE ledger_till_counts
  ADD CONSTRAINT ledger_till_counts_stored_expected_amount_check
  CHECK (stored_expected_amount >= 0);
