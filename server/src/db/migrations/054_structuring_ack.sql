/* Each acknowledgement of one customer on the structuring watch is its own row.
   A later acknowledgement does not replace an earlier one.
   Update and delete are refused. A teller is refused before this table is written. */
CREATE TABLE IF NOT EXISTS ledger_structuring_acks (
  ack_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  actor_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_structuring_acks_customer
  ON ledger_structuring_acks (
    tenant_id, legal_entity_id, branch_id, customer_id,
    acknowledged_at DESC, ack_id DESC
  );

CREATE TRIGGER ledger_structuring_acks_append_only
  BEFORE UPDATE OR DELETE ON ledger_structuring_acks
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
