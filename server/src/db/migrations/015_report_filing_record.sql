/* ============================================================
   Making the filed copy a record instead of a browser artefact.

   Migration 012 built `ledger_report_filings` — the sealed, immutable,
   regulator-facing five-year copy — and gave it a trigger that refuses to
   let a filed row be edited. Nothing ever wrote to it. Every report the
   desk filed went into `localStorage` under `cdos_submissions_v1`, which
   is a place where a compliance record survives exactly until somebody
   clears their browsing data, opens a private window, or sits at the
   second till. The sealed PDF printed "Retain >= 5 years per FINTRAC
   record-keeping" over a copy that a Ctrl+Shift+Delete destroys.

   Three things were missing before that table could actually take the
   traffic, and they are all about being able to answer questions later.

   WHAT WAS THIS FILING ABOUT?
   A filing has to be findable by the obligation it discharges, because
   the desk's question is never "show me filing 3f2a" — it is "has this
   person's Tuesday been reported yet". `obligation_id` is the desk's own
   identifier for that obligation, and it now carries a fingerprint of the
   transaction set: file a four-deal aggregate and then take a fifth deal
   from the same person on the same day and the obligation is a DIFFERENT
   one, which is the entire point. `obligation_group_id` is the same
   identity WITHOUT the set — same person, same day, same report — so the
   later obligation can find what was already filed and link to it rather
   than pretending the first four were never reported.

   WAS IT FILED, OR DOES IT JUST LOOK FILED?
   A filing with no acknowledgement number is a desk asserting it filed
   with nothing to show an examiner. The worksheet already refuses to seal
   without one; the constraint below means the database refuses too.

   AND CAN THE SAME OBLIGATION BE FILED TWICE?
   Only as an amendment. The unique index makes a second unlinked filing
   of the same obligation impossible, so a correction has to say what it
   corrects — which is what `amends_filing_id` was always for.
   ============================================================ */

ALTER TABLE ledger_report_filings
  /* The desk's identifier for the obligation being discharged, with the
     transaction set folded into it. See os-src/cdos-compliance.jsx. */
  ADD COLUMN IF NOT EXISTS obligation_id text,
  /* The same obligation without the set: who, what report, which day.
     Amendments and later-arriving transactions share it. */
  ADD COLUMN IF NOT EXISTS obligation_group_id text,
  /* Who the report is about, as the report names them. Not a foreign key:
     the subject of a suspicious-transaction report may be somebody the
     desk never opened a customer record for. */
  ADD COLUMN IF NOT EXISTS subject_name text,
  /* The desk's own reference printed on the sealed copy, which is what
     staff quote to each other and to the regulator. */
  ADD COLUMN IF NOT EXISTS report_ref text,
  /* Which axis the aggregate was caught on — 'conductor', 'beneficiary',
     'structuring' — or null for a single transaction. The regulator asks
     for it on the form and an examiner asks for it out loud. */
  ADD COLUMN IF NOT EXISTS aggregation_basis text,
  /* The declared aggregation window this report covers. The payload
     carries it too, but a window you cannot query is a window you cannot
     reconcile a year of filings against. */
  ADD COLUMN IF NOT EXISTS window_start timestamptz,
  ADD COLUMN IF NOT EXISTS window_end timestamptz;

/* `subject_transaction_ids` holds the desk's transaction REFERENCES, not
   ledger row ids: the reference is what is printed on the sealed copy and
   what a later filing compares against to work out which deals are
   already covered. */

CREATE INDEX IF NOT EXISTS ledger_report_filings_obligation_group_idx
  ON ledger_report_filings (tenant_id, legal_entity_id, obligation_group_id);

/* One original filing per obligation. A second one has to be an
   amendment, and an amendment has to name what it amends.

   This is the constraint that would have caught the defect this migration
   exists for: an STR was filed, then filed again with all thirty-three
   fields rewritten and a different acknowledgement number, and the desk
   ended up holding ONE record of TWO submissions to the regulator. */
CREATE UNIQUE INDEX IF NOT EXISTS ledger_report_filings_obligation_idx
  ON ledger_report_filings (tenant_id, legal_entity_id, report_code, obligation_id)
  WHERE status = 'filed' AND amends_filing_id IS NULL;

/* A filed report needs the regulator's acknowledgement on it. Drafts do
   not have one yet, and that is what a draft is. */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_report_filings_ack_required'
  ) THEN
    ALTER TABLE ledger_report_filings
      ADD CONSTRAINT ledger_report_filings_ack_required
      CHECK (status = 'draft' OR acknowledgement_ref IS NOT NULL);
  END IF;
END $$;

/* The sealing trigger, corrected. As written in 012 it raised on an
   attempt to change or remove a filed row, which is right, but on a DRAFT
   row `RETURN NEW` is NULL during a DELETE — and a BEFORE DELETE trigger
   returning NULL cancels the delete without saying anything. Deleting a
   draft would have silently done nothing. */
CREATE OR REPLACE FUNCTION ledger_filing_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'filed report is sealed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
