/* Each acknowledgement of one customer on the structuring watch is its own row.
   A later acknowledgement does not replace an earlier one.
   Update and delete are refused. A teller is refused before this table is written. */
CREATE TABLE IF NOT EXISTS __STRAY__ (
  ack_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  customer_id text NOT NULL,
  actor_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX __STRAY___customer
  ON __STRAY__ (
    tenant_id, legal_entity_id, branch_id, customer_id,
    acknowledged_at DESC, ack_id DESC
  );

CREATE TRIGGER __STRAY___append_only
  BEFORE UPDATE OR DELETE ON __STRAY__
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
