ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS do_not_contact_at timestamptz;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS do_not_contact_by text;
ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS do_not_contact_reason text;

CREATE TABLE IF NOT EXISTS enquiry_contact_consents (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  form_version text NOT NULL,
  ip_address text NOT NULL,
  user_agent text,
  timezone text,
  timezone_source text,
  consented_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_contact_consents_idx ON enquiry_contact_consents(enquiry_id, consented_at);

CREATE TABLE IF NOT EXISTS enquiry_research_runs (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  run_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  model text,
  status text NOT NULL,
  summary text,
  credits_used integer,
  cost_cents integer,
  error text,
  created_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS enquiry_research_runs_idx ON enquiry_research_runs(enquiry_id, run_at);

CREATE TABLE IF NOT EXISTS enquiry_research_facts (
  id text PRIMARY KEY,
  research_id text NOT NULL REFERENCES enquiry_research_runs(id),
  key text NOT NULL,
  value text NOT NULL,
  source_url text NOT NULL CHECK (btrim(source_url) <> ''),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  method text NOT NULL CHECK (method IN ('web_search','website_read','registry','model_inference'))
);
CREATE INDEX IF NOT EXISTS enquiry_research_facts_idx ON enquiry_research_facts(research_id);

CREATE TABLE IF NOT EXISTS enquiry_research_reviews (
  id text PRIMARY KEY,
  research_id text NOT NULL REFERENCES enquiry_research_runs(id),
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_research_reviews_idx ON enquiry_research_reviews(research_id, reviewed_at);

CREATE TABLE IF NOT EXISTS enquiry_calls (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  research_id text REFERENCES enquiry_research_runs(id),
  trigger_key text NOT NULL,
  provider text NOT NULL,
  agent_id text NOT NULL,
  provider_call_id text,
  conversation_id text,
  phone text NOT NULL,
  timezone text NOT NULL,
  status text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  placed_at timestamptz,
  completed_at timestamptz,
  duration_seconds integer,
  outcome text,
  recording_url text,
  transcript jsonb,
  summary text,
  error text,
  created_by text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS enquiry_calls_trigger_idx ON enquiry_calls(trigger_key);
CREATE INDEX IF NOT EXISTS enquiry_calls_enquiry_idx ON enquiry_calls(enquiry_id, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS enquiry_calls_conversation_idx ON enquiry_calls(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS platform_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
