/* PEP answers are appended. A later answer does not replace an earlier one.
   A Yes opens a compliance review and does not hold a deal. */
CREATE TABLE IF NOT EXISTS client_pep_answer_events (
  answer_id text PRIMARY KEY,
  client_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  answer text NOT NULL CHECK (answer IN ('yes', 'no', 'not_asked')),
  answered_at timestamptz NOT NULL DEFAULT now(),
  staff_id text NOT NULL
);

CREATE INDEX IF NOT EXISTS client_pep_answer_events_client_idx
  ON client_pep_answer_events (tenant_id, legal_entity_id, client_id, answered_at DESC);

CREATE TABLE IF NOT EXISTS client_pep_reviews (
  review_id text PRIMARY KEY,
  client_id text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  answer_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('open')),
  created_at timestamptz NOT NULL DEFAULT now()
);

/* A later answer is a new row. The earlier one stays. */
CREATE OR REPLACE FUNCTION client_pep_answer_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PEP answers are append-only';
END;
$$;

DROP TRIGGER IF EXISTS client_pep_answer_events_append_only ON client_pep_answer_events;
CREATE TRIGGER client_pep_answer_events_append_only
  BEFORE UPDATE OR DELETE ON client_pep_answer_events
  FOR EACH ROW EXECUTE FUNCTION client_pep_answer_events_append_only();

DROP TRIGGER IF EXISTS client_pep_answer_events_no_truncate ON client_pep_answer_events;
CREATE TRIGGER client_pep_answer_events_no_truncate
  BEFORE TRUNCATE ON client_pep_answer_events
  FOR EACH STATEMENT EXECUTE FUNCTION client_pep_answer_events_append_only();
