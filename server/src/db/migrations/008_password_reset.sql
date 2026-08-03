-- Somebody forgot their password.
--
-- Until this table there was no way back: the sign-in screen told the owner
-- "the owner can reset it", and the only working path was a phone call to
-- the platform team who read a temporary password down the line.
--
-- Only the hash of the code is stored, for the same reason sessions store
-- only the hash of their token — a leak of this table must not be a way in.
-- `attempts` is what makes six digits sufficient: the code dies on the
-- fifth wrong guess, so the space is never walked.
CREATE TABLE IF NOT EXISTS password_resets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES staff_users(id),
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);
