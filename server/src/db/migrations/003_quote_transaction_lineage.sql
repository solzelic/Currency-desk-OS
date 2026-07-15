-- Quote-originated transactions retain their commercial and rate-source
-- lineage independently of later quote or rate-board publications.
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS quote_id text;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS market_mid numeric(24,12);
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS rate_board_publication_id text;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS market_snapshot_id text;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS rate_source_type text;
ALTER TABLE ledger_transactions ADD COLUMN IF NOT EXISTS quote_override_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ledger_transactions_quote_id_unique
  ON ledger_transactions (quote_id)
  WHERE quote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_transactions_rate_board_publication_idx
  ON ledger_transactions (rate_board_publication_id)
  WHERE rate_board_publication_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_transactions_market_snapshot_idx
  ON ledger_transactions (market_snapshot_id)
  WHERE market_snapshot_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_transactions_rate_source_type_check'
  ) THEN
    ALTER TABLE ledger_transactions
      ADD CONSTRAINT ledger_transactions_rate_source_type_check
      CHECK (rate_source_type IS NULL OR rate_source_type IN ('market_sync', 'manual', 'seed'));
  END IF;
END $$;
