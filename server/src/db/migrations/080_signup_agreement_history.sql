-- Signed records are evidence, not mutable progress. No secrets/card data.
CREATE TABLE IF NOT EXISTS signup_agreements (
  id text PRIMARY KEY,
  enquiry_id text NOT NULL REFERENCES enquiries(id),
  account_id text NOT NULL REFERENCES signup_accounts(account_id),
  kind text NOT NULL CHECK (kind IN ('desk','plan')),
  signer_name text NOT NULL,
  declaration_version text NOT NULL,
  answers_hash text NOT NULL CHECK (answers_hash ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  signed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_agreements_enquiry_idx ON signup_agreements(enquiry_id, signed_at);
CREATE OR REPLACE FUNCTION signup_agreement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'signup agreement records are append-only'; END $$;
DROP TRIGGER IF EXISTS signup_agreement_immutable ON signup_agreements;
CREATE TRIGGER signup_agreement_immutable BEFORE UPDATE OR DELETE ON signup_agreements
  FOR EACH ROW EXECUTE FUNCTION signup_agreement_immutable();
