-- A takeover over the CAD threshold names who approved it.
-- The variances are the per-currency count minus book, with the
-- board mid used to value them. Older rows leave these NULL.
ALTER TABLE ledger_audit_events
  ADD COLUMN approver_id text,
  ADD COLUMN approver_role text,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN variances jsonb;

-- Home currency per 1 unit, from the board that valued this line.
-- Older rows leave it NULL. Nothing backfills them.
ALTER TABLE ledger_till_counts
  ADD COLUMN board_mid_rate numeric(24,12);

-- The copy of a handover count on the new session is not a close.
DO $$
DECLARE
  name text;
BEGIN
  SELECT conname INTO name
    FROM pg_constraint
   WHERE conrelid = 'ledger_till_count_batches'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%count_kind%';
  IF name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ledger_till_count_batches DROP CONSTRAINT %I', name);
  END IF;
END $$;

ALTER TABLE ledger_till_count_batches
  ADD CONSTRAINT ledger_till_count_batches_count_kind_check
  CHECK (count_kind IN ('interim', 'close', 'handover'));
