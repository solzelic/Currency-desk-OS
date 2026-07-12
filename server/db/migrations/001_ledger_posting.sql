CREATE TABLE IF NOT EXISTS ledger_users (
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  user_id text NOT NULL, role text NOT NULL, authorized_branch_ids text[] NOT NULL,
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS ledger_customers (
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  customer_id text NOT NULL, name text NOT NULL, risk text NOT NULL, id_status text NOT NULL,
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, customer_id)
);

CREATE TABLE IF NOT EXISTS ledger_tills (
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL, till_id text NOT NULL,
  currency char(3) NOT NULL, available_amount numeric(24,2) NOT NULL CHECK (available_amount >= 0),
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_rates (
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  currency char(3) NOT NULL, units_per_cad numeric(24,12) NOT NULL CHECK (units_per_cad > 0), active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_idempotency (
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL, till_id text NOT NULL,
  idempotency_key text NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS posted_transactions (
  transaction_id text PRIMARY KEY, transaction_ref text NOT NULL UNIQUE,
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL, till_id text NOT NULL,
  customer_id text NOT NULL, teller_id text NOT NULL, status text NOT NULL DEFAULT 'posted' CHECK (status = 'posted'),
  from_currency char(3) NOT NULL, to_currency char(3) NOT NULL,
  input_amount numeric(24,2) NOT NULL, output_amount numeric(24,2) NOT NULL, rate numeric(24,12) NOT NULL,
  fee_cad numeric(24,2) NOT NULL, spread_cad numeric(24,2) NOT NULL, purpose text NOT NULL, source_of_funds text NOT NULL,
  posted_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_entries (
  entry_id bigserial PRIMARY KEY, transaction_id text NOT NULL REFERENCES posted_transactions(transaction_id),
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  account_code text NOT NULL, side text NOT NULL CHECK (side IN ('debit', 'credit')), amount_cad numeric(24,2) NOT NULL CHECK (amount_cad >= 0), created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS till_movements (
  movement_id bigserial PRIMARY KEY, transaction_id text NOT NULL REFERENCES posted_transactions(transaction_id),
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL, till_id text NOT NULL,
  currency char(3) NOT NULL, direction text NOT NULL CHECK (direction IN ('in', 'out')), amount numeric(24,2) NOT NULL CHECK (amount >= 0), created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS transaction_reversals (
  reversal_id text PRIMARY KEY, original_transaction_id text NOT NULL UNIQUE REFERENCES posted_transactions(transaction_id),
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL, till_id text NOT NULL,
  actor_id text NOT NULL, reason text NOT NULL, posted_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS reversal_journal_entries (
  entry_id bigserial PRIMARY KEY, reversal_id text NOT NULL REFERENCES transaction_reversals(reversal_id),
  original_transaction_id text NOT NULL REFERENCES posted_transactions(transaction_id),
  tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  account_code text NOT NULL, side text NOT NULL CHECK (side IN ('debit', 'credit')), amount_cad numeric(24,2) NOT NULL CHECK (amount_cad >= 0), created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_audit_events (
  event_id text PRIMARY KEY, tenant_id text NOT NULL, legal_entity_id text NOT NULL, branch_id text NOT NULL, workspace_id text NOT NULL,
  actor_id text NOT NULL, actor_role text NOT NULL, action text NOT NULL, target_type text NOT NULL, target_id text NOT NULL,
  reason text, correlation_id text NOT NULL, created_at timestamptz NOT NULL, previous_state jsonb, new_state jsonb
);

CREATE OR REPLACE FUNCTION prevent_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'ledger records are append-only'; END; $$;
DROP TRIGGER IF EXISTS posted_transactions_no_delete ON posted_transactions;
CREATE TRIGGER posted_transactions_no_delete BEFORE DELETE ON posted_transactions FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS journal_entries_no_change ON journal_entries;
CREATE TRIGGER journal_entries_no_change BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS till_movements_no_change ON till_movements;
CREATE TRIGGER till_movements_no_change BEFORE UPDATE OR DELETE ON till_movements FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS ledger_audit_no_change ON ledger_audit_events;
CREATE TRIGGER ledger_audit_no_change BEFORE UPDATE OR DELETE ON ledger_audit_events FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
DROP TRIGGER IF EXISTS reversal_journal_no_change ON reversal_journal_entries;
CREATE TRIGGER reversal_journal_no_change BEFORE UPDATE OR DELETE ON reversal_journal_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
