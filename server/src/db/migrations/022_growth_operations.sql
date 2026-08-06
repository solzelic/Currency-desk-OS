-- The operational layer around research. Public signup only commits a job;
-- a worker owns provider latency, retries and failure state after the lead is safe.
ALTER TABLE enquiry_research_runs ADD COLUMN IF NOT EXISTS brief jsonb;

CREATE TABLE IF NOT EXISTS enquiry_growth_jobs (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  research_id text REFERENCES enquiry_research_runs(id),
  error text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_growth_jobs_queue_idx ON enquiry_growth_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS enquiry_growth_jobs_enquiry_idx ON enquiry_growth_jobs(enquiry_id, created_at);

CREATE TABLE IF NOT EXISTS enquiry_growth_events (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_growth_events_idx ON enquiry_growth_events(enquiry_id, created_at);

-- Assignments are events, not a mutable owner column. The latest row is the
-- current owner and the history still answers who was responsible yesterday.
CREATE TABLE IF NOT EXISTS enquiry_growth_assignments (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  assigned_to text,
  assigned_by text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enquiry_growth_assignments_idx ON enquiry_growth_assignments(enquiry_id, assigned_at);
