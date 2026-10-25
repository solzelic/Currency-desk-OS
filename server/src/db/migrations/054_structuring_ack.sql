/* A supervisor's acknowledgement of one customer on the structuring watch.
   The row is the record. A teller is refused before this table is written. */
CREATE TABLE IF NOT EXISTS ledger_structuring_acks (
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  actor_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, customer_id)
);
