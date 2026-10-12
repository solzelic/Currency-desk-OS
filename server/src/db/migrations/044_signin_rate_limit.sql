-- Shop sign-in guesses, and the marker that the password step passed.
--
-- Failure counts used to live in the process. A Render sleep or a deploy
-- handed the next guess a clean slate. They are rows now: five wrong
-- passwords on one account, or twenty from one address, inside fifteen
-- minutes, and the door stays shut until that window ends.
--
-- login_challenges is the other half. The emailed code is checked only
-- for the browser that already proved the password. The cookie is random;
-- this table keeps its hash, and the hash of the code, for the same reason
-- sessions keep a hash — a copy of the table is not a way in. The row
-- goes away with the staff user (a desk being deleted mid sign-in must
-- not trip the foreign key).

CREATE TABLE IF NOT EXISTS signin_failures (
  bucket text PRIMARY KEY,
  failures integer NOT NULL,
  window_started_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_challenges_user_idx ON login_challenges(user_id);
