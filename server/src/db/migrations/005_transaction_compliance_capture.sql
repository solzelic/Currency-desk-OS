ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS third_party boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS third_party_name text,
  ADD COLUMN IF NOT EXISTS compliance_captured_by text,
  ADD COLUMN IF NOT EXISTS compliance_captured_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'ledger_transactions_third_party_capture_check'
  ) THEN
    ALTER TABLE ledger_transactions
      ADD CONSTRAINT ledger_transactions_third_party_capture_check
      CHECK (
        (third_party AND NULLIF(btrim(third_party_name), '') IS NOT NULL)
        OR
        (NOT third_party AND third_party_name IS NULL)
      );
  END IF;
END $$;
