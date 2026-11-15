/* Exchange v2.9, Canada.
   ID checks, reveal reasons, holds, the 24 hour cash total, occupation
   on a large FX deal, and a prepared LCTR draft when the client has left.
   073 is the last file on this branch, so this one is 074.
   A prepared draft cannot become a filed report. */
CREATE TABLE IF NOT EXISTS client_id_checks (
  check_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  customer_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('photo_id_in_person', 'returning_client')),
  doc_type text,
  number_ciphertext text,
  number_last4 text,
  number_length integer,
  issuer_region text,
  issuer_country text,
  expires_on date,
  checked_on date NOT NULL,
  checked_by text NOT NULL,
  lifts_lock boolean NOT NULL,
  original_checked_on date,
  doubt boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_id_checks_shop_idx
  ON client_id_checks (legal_entity_id, customer_id, checked_on DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS id_reveal_reasons (
  code text PRIMARY KEY,
  label text NOT NULL,
  requires_note boolean NOT NULL DEFAULT false,
  min_note_length integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO id_reveal_reasons (code, label, requires_note, min_note_length, sort_order, active)
VALUES
  ('fintrac_request', 'FINTRAC request', false, 0, 1, true),
  ('report_filing', 'report filing', false, 0, 2, true),
  ('id_mismatch', 'ID mismatch', false, 0, 3, true),
  ('client_request', 'client request', false, 0, 4, true),
  ('other', 'Other', true, 10, 5, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS id_number_access (
  access_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  customer_id text NOT NULL,
  check_id text NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL CHECK (action IN ('reveal', 'export')),
  reason_code text NOT NULL,
  note text,
  accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS id_number_access_check_idx
  ON id_number_access (legal_entity_id, check_id, accessed_at DESC);

CREATE TABLE IF NOT EXISTS exchange_holds (
  hold_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  customer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'cancelled', 'expired', 'picked_up')),
  cash_moved boolean NOT NULL,
  cash_home numeric(24,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  superseded_by text,
  CONSTRAINT exchange_holds_cash_shape CHECK (
    (cash_moved AND cash_home IS NOT NULL AND cash_home > 0)
    OR (NOT cash_moved AND (cash_home IS NULL OR cash_home = 0))
  )
);
CREATE INDEX IF NOT EXISTS exchange_holds_window_idx
  ON exchange_holds (legal_entity_id, customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compliance_review_items (
  item_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  transaction_id text,
  kind text NOT NULL CHECK (kind IN ('purpose_declined', 'source_declined', 'lctr_client_left')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lctr_prepare_drafts (
  draft_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  transaction_id text NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status = 'prepared'),
  cash_total numeric(24,2) NOT NULL,
  client_left_gap boolean NOT NULL,
  gap_note text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_deal_facts (
  transaction_id text PRIMARY KEY,
  subject_kind text NOT NULL CHECK (subject_kind IN ('individual', 'entity')),
  occupation_code text,
  occupation_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_risk_ratings (
  legal_entity_id text NOT NULL,
  customer_id text NOT NULL,
  suggested text CHECK (suggested IS NULL OR suggested IN ('low', 'normal', 'medium', 'high')),
  confirmed text CHECK (confirmed IS NULL OR confirmed IN ('low', 'normal', 'medium', 'high')),
  confirmed_by text,
  confirmed_at timestamptz,
  PRIMARY KEY (legal_entity_id, customer_id)
);

CREATE TABLE IF NOT EXISTS fx_occupation_options (
  code text PRIMARY KEY,
  label text NOT NULL,
  applies_to text NOT NULL CHECK (applies_to IN ('individual', 'entity', 'both')),
  sort_order integer NOT NULL,
  active boolean NOT NULL DEFAULT true
);
INSERT INTO fx_occupation_options (code, label, applies_to, sort_order)
VALUES
  ('employed', 'Employed', 'individual', 1),
  ('self_employed', 'Self-employed', 'individual', 2),
  ('retired', 'Retired', 'individual', 3),
  ('student', 'Student', 'individual', 4),
  ('unemployed', 'Not employed', 'individual', 5),
  ('retail', 'Retail', 'entity', 1),
  ('professional', 'Professional services', 'entity', 2),
  ('trade', 'Import or export', 'entity', 3),
  ('food', 'Food service', 'entity', 4),
  ('other', 'Other', 'both', 9)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION exchange_hold_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a hold stays in the log';
END;
$$;
DROP TRIGGER IF EXISTS exchange_holds_no_delete ON exchange_holds;
CREATE TRIGGER exchange_holds_no_delete
  BEFORE DELETE ON exchange_holds
  FOR EACH ROW EXECUTE FUNCTION exchange_hold_keep();
DROP TRIGGER IF EXISTS exchange_holds_no_truncate ON exchange_holds;
CREATE TRIGGER exchange_holds_no_truncate
  BEFORE TRUNCATE ON exchange_holds
  FOR EACH STATEMENT EXECUTE FUNCTION exchange_hold_keep();

CREATE OR REPLACE FUNCTION lctr_prepare_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a prepared LCTR draft is not removed';
  END IF;
  IF NEW.status IS DISTINCT FROM 'prepared' THEN
    RAISE EXCEPTION 'LCTR draft stays prepared and is not filed';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS lctr_prepare_drafts_no_delete ON lctr_prepare_drafts;
CREATE TRIGGER lctr_prepare_drafts_no_delete
  BEFORE DELETE ON lctr_prepare_drafts
  FOR EACH ROW EXECUTE FUNCTION lctr_prepare_only();
DROP TRIGGER IF EXISTS lctr_prepare_drafts_no_file ON lctr_prepare_drafts;
CREATE TRIGGER lctr_prepare_drafts_no_file
  BEFORE UPDATE ON lctr_prepare_drafts
  FOR EACH ROW EXECUTE FUNCTION lctr_prepare_only();

DROP TRIGGER IF EXISTS client_id_checks_append_only ON client_id_checks;
CREATE TRIGGER client_id_checks_append_only
  BEFORE UPDATE OR DELETE ON client_id_checks
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
DROP TRIGGER IF EXISTS client_id_checks_no_truncate ON client_id_checks;
CREATE TRIGGER client_id_checks_no_truncate
  BEFORE TRUNCATE ON client_id_checks
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS id_number_access_append_only ON id_number_access;
CREATE TRIGGER id_number_access_append_only
  BEFORE UPDATE OR DELETE ON id_number_access
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
DROP TRIGGER IF EXISTS id_number_access_no_truncate ON id_number_access;
CREATE TRIGGER id_number_access_no_truncate
  BEFORE TRUNCATE ON id_number_access
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS compliance_review_items_append_only ON compliance_review_items;
CREATE TRIGGER compliance_review_items_append_only
  BEFORE UPDATE OR DELETE ON compliance_review_items
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
DROP TRIGGER IF EXISTS compliance_review_items_no_truncate ON compliance_review_items;
CREATE TRIGGER compliance_review_items_no_truncate
  BEFORE TRUNCATE ON compliance_review_items
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
