/* ============================================================
   The forms a jurisdiction makes you file, and the record that you did.

   A pack already said what currency a desk books in and what its
   thresholds are. That is the easy half. The half that decides whether a
   desk can legally operate in a country is the REPORTING: which forms
   exist, what is on them, what triggers one, and proof it was filed.

   The desk already does this beautifully for Canada — a worksheet listing
   every field in the regulator's own form order, pre-filled from the
   ledger and the client record, which the owner reads down into the FWR
   login; then the acknowledgement number is pasted back and the whole
   thing freezes into the five-year copy.

   Two things were wrong with it. The form was hardcoded to FINTRAC, so a
   London desk had no form at all. And the filed record — the sealed,
   immutable, regulator-facing five-year copy — lived in a browser's
   localStorage, which is not a place a compliance record can live.

   So a report becomes part of the pack, and a filing becomes a row.
   ============================================================ */

/* What a regulator's form is: a code, a name, what brings it into
   existence, and the fields on it IN THE ORDER THE FORM PRINTS THEM.
   The field list is data because every country's form is different and
   none of them are our design — we are transcribing somebody else's
   paperwork, and transcription belongs in a table, not in a component. */
CREATE TABLE IF NOT EXISTS jurisdiction_reports (
  report_id text PRIMARY KEY,
  pack_id text NOT NULL REFERENCES jurisdiction_packs(pack_id),
  /* LCTR, CTR, EFTR, SAR, STR, MLR… the regulator's own short code, which
     is what staff and examiners actually call it */
  code text NOT NULL,
  name text NOT NULL,
  /* 'large_cash' | 'wire' | 'suspicious' — what class of obligation this
     is, so the engine knows which detector feeds it without matching on
     the country's own naming */
  kind text NOT NULL CHECK (kind IN ('large_cash', 'wire', 'suspicious', 'other')),
  /* what brings it into existence. A threshold of null means the report is
     never triggered by amount — a suspicious-activity report is raised by a
     person, not by arithmetic. */
  trigger_threshold numeric(24,2),
  trigger_currency char(3),
  /* how long a window transactions are aggregated over before the
     threshold is tested. Canada uses 24 hours; it is not universal. */
  aggregation_hours integer,
  /* how the completed report is actually submitted, in the regulator's own
     terms — "FWR JSON batch", "BSA E-Filing XML". Shown to the filer,
     because the desk files it themselves in the regulator's portal. */
  filing_format text,
  /* the form itself: an ordered list of
     { id, label, section, source, format, required, help }
     where `source` says where the value comes from — 'config', 'ledger',
     'kyc', 'engine' or 'prompt'. Only 'prompt' fields are blanks the
     teller has to answer at the counter. */
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  /* per-country formatting traps that are wrong everywhere else, e.g.
     Canada's HH:MM:SS±ZZ:ZZ timestamps, and reporting foreign cash in its
     ORIGINAL currency while testing the threshold in home currency */
  format_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pack_id, code, version)
);

CREATE INDEX IF NOT EXISTS jurisdiction_reports_pack_idx
  ON jurisdiction_reports (pack_id, kind);

/* A filing: the sealed copy. Immutable once submitted, because its whole
   purpose is to be the thing shown to an examiner years later.

   `payload` is every field AS SUBMITTED, not a reference to today's data —
   a report re-rendered from live records is not the report that was filed,
   and the difference between those two is the entire point of keeping it. */
CREATE TABLE IF NOT EXISTS ledger_report_filings (
  filing_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  report_id text NOT NULL REFERENCES jurisdiction_reports(report_id),
  /* snapshotted, so a pack revised next year cannot restate what was sent */
  pack_id text NOT NULL,
  pack_version integer NOT NULL,
  report_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'filed', 'amended', 'rejected')),
  /* every field as submitted */
  payload jsonb NOT NULL,
  /* what the desk is reporting on: transaction ids, customer ids */
  subject_transaction_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject_customer_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  /* the amount that tripped the threshold, and in what */
  reported_amount numeric(24,2),
  reported_currency char(3),
  /* THE ACKNOWLEDGEMENT. The number the regulator's portal hands back on
     submission — the desk's only proof it filed. Typed in by the person
     who filed it, which is why it is nullable until they do. */
  acknowledgement_ref text,
  filed_by text,
  filed_at timestamptz,
  /* an amendment points at what it supersedes; the original is never
     altered, because a corrected filing and a rewritten one are very
     different things to an examiner */
  amends_filing_id text REFERENCES ledger_report_filings(filing_id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_report_filings_scope_idx
  ON ledger_report_filings (tenant_id, legal_entity_id, branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_report_filings_status_idx
  ON ledger_report_filings (tenant_id, status, report_code);

/* A filed report is evidence. Drafts stay editable — that is what a draft
   is — but the moment it is filed it stops being ours to change. */
CREATE OR REPLACE FUNCTION ledger_filing_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'filed report is sealed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_report_filings_sealed ON ledger_report_filings;
CREATE TRIGGER ledger_report_filings_sealed
  BEFORE UPDATE OR DELETE ON ledger_report_filings
  FOR EACH ROW EXECUTE FUNCTION ledger_filing_sealed();

/* The reports each seeded pack makes you file. Thresholds match the packs
   they belong to. Field lists are seeded empty here and transcribed per
   form — an empty list is honestly "not transcribed yet", where a guessed
   one would be a form that looks official and is wrong. */
INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind, trigger_threshold, trigger_currency,
   aggregation_hours, filing_format)
VALUES
  ('rpt-ca-lctr', 'pack-ca-v1', 'LCTR', 'Large Cash Transaction Report', 'large_cash', 10000, 'CAD', 24, 'FWR JSON batch'),
  ('rpt-ca-eftr', 'pack-ca-v1', 'EFTR', 'Electronic Funds Transfer Report', 'wire', 10000, 'CAD', 24, 'FWR JSON batch'),
  ('rpt-ca-str',  'pack-ca-v1', 'STR',  'Suspicious Transaction Report', 'suspicious', NULL, NULL, NULL, 'FWR JSON batch'),
  ('rpt-us-ctr',  'pack-us-v1', 'CTR',  'Currency Transaction Report', 'large_cash', 10000, 'USD', 24, 'BSA E-Filing XML'),
  ('rpt-us-sar',  'pack-us-v1', 'SAR',  'Suspicious Activity Report', 'suspicious', NULL, NULL, NULL, 'BSA E-Filing XML'),
  ('rpt-gb-mlr',  'pack-gb-v1', 'MLR',  'Money Laundering Report', 'suspicious', NULL, NULL, NULL, 'NCA SAR Online'),
  ('rpt-eu-str',  'pack-eu-v1', 'STR',  'Suspicious Transaction Report', 'suspicious', NULL, NULL, NULL, 'National FIU portal'),
  ('rpt-au-ttr',  'pack-au-v1', 'TTR',  'Threshold Transaction Report', 'large_cash', 10000, 'AUD', 24, 'AUSTRAC Online'),
  ('rpt-au-smr',  'pack-au-v1', 'SMR',  'Suspicious Matter Report', 'suspicious', NULL, NULL, NULL, 'AUSTRAC Online'),
  ('rpt-ae-str',  'pack-ae-v1', 'STR',  'Suspicious Transaction Report', 'suspicious', NULL, NULL, NULL, 'goAML')
ON CONFLICT (report_id) DO NOTHING;
