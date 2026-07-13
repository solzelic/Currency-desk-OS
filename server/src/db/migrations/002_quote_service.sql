CREATE TABLE IF NOT EXISTS quotes (
  quote_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  customer_id text NOT NULL,
  created_by text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('customer_buy_foreign','customer_sell_foreign')),
  from_currency char(3) NOT NULL,
  to_currency char(3) NOT NULL,
  input_amount numeric(24,2) NOT NULL CHECK (input_amount > 0),
  output_amount numeric(24,2) NOT NULL CHECK (output_amount >= 0),
  market_mid numeric(24,12) NOT NULL,
  customer_rate numeric(24,12) NOT NULL,
  buy_or_sell_side text NOT NULL CHECK (buy_or_sell_side IN ('we_buy','we_sell')),
  fee_cad numeric(24,2) NOT NULL CHECK (fee_cad >= 0),
  spread_cad numeric(24,2) NOT NULL CHECK (spread_cad >= 0),
  rate_board_publication_id text NOT NULL,
  market_snapshot_id text,
  status text NOT NULL CHECK (status IN ('draft','active','expired','cancelled','posted','rejected')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  posted_transaction_id text UNIQUE,
  supersedes_quote_id text REFERENCES quotes(quote_id)
);
CREATE INDEX IF NOT EXISTS quotes_scope_idx ON quotes(tenant_id, legal_entity_id, branch_id, workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS quote_overrides (
  override_id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES quotes(quote_id),
  actor_id text NOT NULL,
  original_market_mid numeric(24,12) NOT NULL,
  original_customer_rate numeric(24,12) NOT NULL,
  overridden_customer_rate numeric(24,12) NOT NULL,
  overridden_output_amount numeric(24,2) NOT NULL,
  overridden_spread_cad numeric(24,2) NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS quote_events (
  event_id text PRIMARY KEY,
  quote_id text NOT NULL REFERENCES quotes(quote_id),
  actor_id text NOT NULL,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION quote_terms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('active','expired','cancelled','posted','rejected') AND (
    NEW.input_amount <> OLD.input_amount OR NEW.output_amount <> OLD.output_amount OR
    NEW.market_mid <> OLD.market_mid OR NEW.customer_rate <> OLD.customer_rate OR
    NEW.fee_cad <> OLD.fee_cad OR NEW.spread_cad <> OLD.spread_cad OR
    NEW.rate_board_publication_id <> OLD.rate_board_publication_id
  ) THEN RAISE EXCEPTION 'activated quote terms are immutable'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS quote_terms_immutable_trigger ON quotes;
CREATE TRIGGER quote_terms_immutable_trigger BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION quote_terms_immutable();
