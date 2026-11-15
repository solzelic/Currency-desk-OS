-- Sign-up v2.1, the email code and the enrolment session (SIGNUP-LOGIC §3.2, §6).
--
-- signup_accounts gains the one active code: its SHA-256 (never the code),
-- when it dies, how many wrong tries it has taken, and when codes were
-- sent (3 per 15 minutes).
--
-- enrolment_sessions: issued when the code passes. Chapters 2 to 5 for this
-- one reservation only, never the desk API. 24 hours sliding. Only the
-- SHA-256 of the cookie token is stored, as with desk sessions.
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS code_hash text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS code_expires_at timestamptz;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS code_sends jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE TABLE IF NOT EXISTS enrolment_sessions (
  token_hash text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS enrolment_sessions_enquiry_idx ON enrolment_sessions (enquiry_id);
