/* Screen results, the review queue, and the ask-the-client PEP answer.
   A teller API does not read the matched name. The queue does. */
CREATE TABLE IF NOT EXISTS sanctions_screenings (
  screening_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  client_id text,
  customer_id text,
  quote_id text,
  subject_name text NOT NULL,
  subject_dob date,
  outcome text NOT NULL CHECK (outcome IN ('clear', 'possible', 'confirmed', 'not_screened')),
  score numeric,
  matched_entry_key text,
  matched_name text,
  matched_source_key text,
  list_snapshots jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sanctions_screenings
  ADD COLUMN IF NOT EXISTS list_snapshots jsonb NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS sanctions_screenings_client_idx
  ON sanctions_screenings (tenant_id, legal_entity_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sanctions_reviews (
  review_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  client_id text,
  customer_id text,
  quote_id text,
  screening_id text NOT NULL,
  subject_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'cleared', 'confirmed')),
  matched_entry_key text,
  matched_name text,
  matched_source_key text,
  score numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sanctions_reviews_open_idx
  ON sanctions_reviews (tenant_id, legal_entity_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS sanctions_review_decisions (
  decision_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES sanctions_reviews(review_id),
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('clear', 'confirm')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_pep_answers (
  client_id text PRIMARY KEY REFERENCES desk_clients(client_id),
  tier text NOT NULL,
  is_pep boolean NOT NULL,
  answered_at timestamptz NOT NULL,
  answered_by text NOT NULL
);
