/* ============================================================
   The vault, on the ledger.

   Until now the ledger knew about tills and nothing else. A vault was a
   label on a till movement — counterparty_type='vault' — so cash could
   be issued to a drawer from a vault that the server had no balance for,
   and never checked. The vault's own holdings lived in one browser's
   localStorage, which meant they could not be audited, could not be
   reconciled, and quietly disagreed with themselves across devices.

   A vault belongs to a BRANCH, not to a workspace or a till: one strong
   room, feeding every drawer in that location. Balances are per currency
   and can never go negative — the same rule the till already lives by.

   Every change to a vault balance writes a movement row, and those rows
   are append-only. A vault run between two branches writes two of them,
   one out and one in, pointing at each other through related_movement_id
   so the pair can never be read as two unrelated events.
   ============================================================ */

CREATE TABLE IF NOT EXISTS ledger_vault_balances (
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  currency char(3) NOT NULL,
  available_amount numeric(24,2) NOT NULL CHECK (available_amount >= 0),
  PRIMARY KEY (tenant_id, legal_entity_id, branch_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_vault_movements (
  movement_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  currency char(3) NOT NULL,
  amount numeric(24,2) NOT NULL CHECK (amount > 0),
  /* where the money came from or went to. 'till' is a drawer at this
     branch, 'vault' is another branch's strong room, 'supplier' is a
     wholesale delivery, 'bank' a deposit or withdrawal. */
  counterparty_type text NOT NULL CHECK (
    counterparty_type IN ('till', 'vault', 'supplier', 'bank', 'other')
  ),
  counterparty_ref text NOT NULL,
  /* the other half: the paired vault leg of a run, or the till movement
     this leg balances. Null for money entering from outside the desk. */
  related_movement_id text,
  reason text NOT NULL,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (tenant_id, legal_entity_id, branch_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ledger_vault_movements_branch_idx
  ON ledger_vault_movements (
    tenant_id, legal_entity_id, branch_id, created_at DESC
  );

DROP TRIGGER IF EXISTS ledger_vault_movements_immutable
  ON ledger_vault_movements;
CREATE TRIGGER ledger_vault_movements_immutable
  BEFORE UPDATE OR DELETE ON ledger_vault_movements
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
