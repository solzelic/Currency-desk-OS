-- Sign-up v2.1, the owner's account before the desk exists (SIGNUP-LOGIC §3, §10).
--
-- signup_accounts: one per reservation. Its state is the v2.1 account
-- state machine: reserved -> enrolling (a credential saved) -> verified
-- (the email code) -> active (the payment webhook). account_id is the
-- WebAuthn user handle: random, never the email.
--
-- signup_credentials: what the owner chose to sign in with. A passkey's
-- public half, a Google or Microsoft subject, or a password hash; never a
-- secret in the clear. attempt_hash ties a credential to the browser that
-- saved it (a SHA-256 of an httpOnly cookie), so only the browser that
-- enters the email code turns its own credential into the verified one.
--
-- signup_challenges: one-use WebAuthn challenges and OIDC state/PKCE,
-- five minutes, tied to the same attempt.
CREATE TABLE IF NOT EXISTS signup_accounts (
  enquiry_id text PRIMARY KEY REFERENCES enquiries(id),
  account_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'reserved',
  email_verified_at timestamptz,
  last_step text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE signup_accounts DROP CONSTRAINT IF EXISTS signup_accounts_state_check;
ALTER TABLE signup_accounts ADD CONSTRAINT signup_accounts_state_check CHECK (state IN ('reserved', 'enrolling', 'verified', 'active'));
CREATE TABLE IF NOT EXISTS signup_credentials (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  kind text NOT NULL,
  attempt_hash text NOT NULL,
  verified_at timestamptz,
  passkey_id text UNIQUE,
  public_key text,
  sign_count bigint,
  transports jsonb,
  aaguid text,
  backup_eligible boolean,
  backup_state boolean,
  device_label text,
  sso_subject text,
  sso_tenant text,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE signup_credentials DROP CONSTRAINT IF EXISTS signup_credentials_kind_check;
ALTER TABLE signup_credentials ADD CONSTRAINT signup_credentials_kind_check CHECK (kind IN ('passkey', 'google', 'microsoft', 'password'));
CREATE INDEX IF NOT EXISTS signup_credentials_enquiry_idx ON signup_credentials (enquiry_id);
CREATE UNIQUE INDEX IF NOT EXISTS signup_credentials_sso_idx ON signup_credentials (kind, sso_subject) WHERE sso_subject IS NOT NULL AND verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS signup_challenges (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  purpose text NOT NULL,
  challenge text NOT NULL,
  verifier text,
  nonce text,
  attempt_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE signup_challenges DROP CONSTRAINT IF EXISTS signup_challenges_purpose_check;
ALTER TABLE signup_challenges ADD CONSTRAINT signup_challenges_purpose_check CHECK (purpose IN ('passkey', 'google', 'microsoft'));
CREATE INDEX IF NOT EXISTS signup_challenges_idx ON signup_challenges (enquiry_id, created_at);
