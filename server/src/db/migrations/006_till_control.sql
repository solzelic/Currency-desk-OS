CREATE TABLE IF NOT EXISTS ledger_till_sessions (
  session_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  session_number integer NOT NULL CHECK (session_number > 0),
  business_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  opened_by text NOT NULL,
  opened_at timestamptz NOT NULL,
  closed_by text,
  closed_at timestamptz,
  close_note text,
  CHECK (
    (status = 'open' AND closed_by IS NULL AND closed_at IS NULL)
    OR
    (status = 'closed' AND closed_by IS NOT NULL AND closed_at IS NOT NULL)
  ),
  UNIQUE (
    tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
    session_number
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_till_one_open_session
  ON ledger_till_sessions (
    tenant_id, legal_entity_id, branch_id, workspace_id, till_id
  )
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS ledger_till_count_batches (
  batch_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES ledger_till_sessions(session_id),
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  count_kind text NOT NULL CHECK (count_kind IN ('interim', 'close')),
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  counted_at timestamptz NOT NULL,
  UNIQUE (
    tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
    session_id, idempotency_key
  )
);

CREATE TABLE IF NOT EXISTS ledger_till_counts (
  count_id bigserial PRIMARY KEY,
  batch_id text NOT NULL REFERENCES ledger_till_count_batches(batch_id),
  currency char(3) NOT NULL,
  expected_amount numeric(24,2) NOT NULL CHECK (expected_amount >= 0),
  counted_amount numeric(24,2) NOT NULL CHECK (counted_amount >= 0),
  variance_amount numeric(24,2) NOT NULL,
  UNIQUE (batch_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_operational_cash_movements (
  movement_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  session_id text REFERENCES ledger_till_sessions(session_id),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  currency char(3) NOT NULL,
  amount numeric(24,2) NOT NULL CHECK (amount > 0),
  counterparty_type text NOT NULL CHECK (
    counterparty_type IN ('vault', 'bank', 'other')
  ),
  counterparty_ref text NOT NULL,
  reason text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (
    tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
    idempotency_key
  )
);

DROP TRIGGER IF EXISTS ledger_till_count_batches_immutable
  ON ledger_till_count_batches;
CREATE TRIGGER ledger_till_count_batches_immutable
  BEFORE UPDATE OR DELETE ON ledger_till_count_batches
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS ledger_till_counts_immutable ON ledger_till_counts;
CREATE TRIGGER ledger_till_counts_immutable
  BEFORE UPDATE OR DELETE ON ledger_till_counts
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS ledger_operational_cash_movements_immutable
  ON ledger_operational_cash_movements;
CREATE TRIGGER ledger_operational_cash_movements_immutable
  BEFORE UPDATE OR DELETE ON ledger_operational_cash_movements
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
