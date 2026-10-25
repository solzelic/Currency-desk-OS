/* A booking error on a deal already named in a prepared or filed LCTR
   leaves that filing row untouched. The flag lives beside it, one per filing. */
CREATE TABLE IF NOT EXISTS ledger_filing_flags (
  filing_id text PRIMARY KEY REFERENCES ledger_report_filings (filing_id),
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  flag_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
