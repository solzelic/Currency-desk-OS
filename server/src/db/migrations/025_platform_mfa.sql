-- Platform-operator authenticator (issue #33).
--
-- The desk door stays password-only. This is the second factor for the
-- cross-tenant panel only.
--
-- The TOTP secret is reversible ciphertext (the server has to compute the
-- code). Backup codes are one-way hashes, scrypt, same as a password: a
-- leak of this table must not be a list of working codes. `used_at` is
-- what makes a backup code single-use.
--
-- A sign-in challenge lives here rather than in process memory. Render
-- sleeps, and an enrollment that vanishes on sleep is how an operator
-- gets stuck halfway through setup.
--
-- sessions.platform_mfa_at is set only when this sign-in presented a
-- valid authenticator or backup code. A desk session does not have it,
-- and once the operator has enrolled, the panel refuses a session
-- without it.

ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS totp_secret_enc text;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS totp_enrolled_at timestamptz;
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS totp_last_step integer;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS platform_mfa_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_mfa_backup_codes (
  id text PRIMARY KEY,
  email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_mfa_backup_codes_email_idx ON platform_mfa_backup_codes(email);

CREATE TABLE IF NOT EXISTS platform_mfa_challenges (
  id text PRIMARY KEY,
  email text NOT NULL REFERENCES platform_users(email) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('enroll', 'login')),
  secret_enc text,
  backup_hashes jsonb,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_mfa_challenges_email_idx ON platform_mfa_challenges(email);
