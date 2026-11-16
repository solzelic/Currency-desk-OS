-- Sign-up v2.1, the counter PIN (SIGNUP-LOGIC §3.3). Hashed like every PIN
-- (routes/pin.ts hashPin); copied to the owner's staff row when the desk
-- opens. Never stored or logged in the clear.
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS pin_set_at timestamptz;
