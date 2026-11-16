-- Sign-up v2.1, chapter 5: confirm, plan, pay (SIGNUP-LOGIC §5).
--
-- The signed declaration: when, the name typed as the signature, which
-- wording, and a SHA-256 of the answers as confirmed (an edit after it
-- clears the confirmation). The plan chosen, and the Stripe customer and
-- SetupIntent that hold the card. No money moves at sign-up: $0 today.
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS confirmed_name text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS declaration_version text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS answers_hash text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS plan_choice jsonb;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE signup_accounts ADD COLUMN IF NOT EXISTS setup_intent_id text;
CREATE UNIQUE INDEX IF NOT EXISTS signup_accounts_setup_intent_idx ON signup_accounts (setup_intent_id) WHERE setup_intent_id IS NOT NULL;
