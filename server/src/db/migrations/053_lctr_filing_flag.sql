/* A booking error on a deal already named in a prepared or filed LCTR
   leaves that filing row untouched. One row per deal. The sentence is
   chosen when the flag is read. Deleting a draft filing removes its flags.
   A filed report cannot be deleted: ledger_filing_sealed raises. */
CREATE TABLE IF NOT EXISTS ledger_filing_flags (
  filing_id text NOT NULL REFERENCES ledger_report_filings (filing_id) ON DELETE CASCADE,
  transaction_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  actor_id text NOT NULL,
  posted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (filing_id, transaction_id)
);
