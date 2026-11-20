-- Staff sign-in identities (CD-273).
--
-- A Google or Microsoft account can be linked to a staff row that already
-- exists. Sign-in does not create a staff row, a tenant, or a shop from
-- this table. The same IdP identity may be linked in two shops: the unique
-- key includes the staff user, so the desk must ask which shop.
--
-- Passkeys, one-use challenges, and owner recovery codes live here too.
-- Recovery codes store a scrypt hash only. Challenges store hashes of
-- state, not IdP access or refresh tokens.
--
-- tenants.ms_tenant_allowlist null means that shop has not turned the
-- Microsoft tenant allowlist on. sessions.step_up_at is the fresh
-- step-up marker. staff_totp holds an owner authenticator ciphertext.

CREATE TABLE IF NOT EXISTS staff_identities (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  staff_user_id text NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  issuer text NOT NULL,
  subject text NOT NULL,
  ms_tid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS staff_identities_tenant_subject_idx
  ON staff_identities (tenant_id, issuer, subject);
CREATE UNIQUE INDEX IF NOT EXISTS staff_identities_user_provider_idx
  ON staff_identities (staff_user_id, provider);
CREATE INDEX IF NOT EXISTS staff_identities_subject_idx
  ON staff_identities (provider, subject);
CREATE INDEX IF NOT EXISTS staff_identities_ms_tid_idx
  ON staff_identities (provider, ms_tid, subject);

CREATE TABLE IF NOT EXISTS staff_passkeys (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  staff_user_id text NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  sign_count integer NOT NULL DEFAULT 0,
  transports jsonb NOT NULL DEFAULT '[]',
  aaguid text NOT NULL DEFAULT '',
  backup_eligible boolean NOT NULL DEFAULT false,
  backup_state boolean NOT NULL DEFAULT false,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS staff_passkeys_user_idx ON staff_passkeys (staff_user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  purpose text NOT NULL CHECK (purpose IN ('oidc_signin', 'oidc_link', 'passkey_register', 'passkey_auth', 'stepup')),
  challenge_hash text NOT NULL,
  nonce text,
  verifier text,
  provider text,
  return_to text,
  issuer text,
  subject text,
  ms_tid text,
  staff_user_id text REFERENCES staff_users(id) ON DELETE CASCADE,
  session_hash text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_challenges_hash_idx ON auth_challenges (purpose, challenge_hash);

CREATE TABLE IF NOT EXISTS staff_recovery_codes (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  staff_user_id text NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_recovery_codes_user_idx ON staff_recovery_codes (staff_user_id);

CREATE TABLE IF NOT EXISTS staff_totp (
  staff_user_id text PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL REFERENCES tenants(id),
  secret_enc text NOT NULL,
  enrolled_at timestamptz,
  last_step integer
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ms_tenant_allowlist jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS step_up_at timestamptz;
