/* ============================================================
   Cost basis and realized P&L.

   The book valued inventory at the market mid of the moment and credited
   the gap to the customer's rate as revenue. That books a profit the
   instant a trade happens, against a price the desk never paid, and it
   cannot answer "did we make money on US dollars this month".

   Cost now travels with the cash. Every balance carries a weighted-average
   unit cost in the home currency; every change to that average writes an
   append-only event that says what happened and what the average was
   before and after. A desk that cannot explain a basis does not have one.

   See docs/COST_BASIS.md.
   ============================================================ */

/* Weighted average cost per unit, in home currency, alongside the quantity
   it belongs to. Twelve decimal places because an average is a computed
   ratio, not a money amount — rounding it to cents at every acquisition
   would drift the basis over a day of trading.

   NULL means "this balance predates cost tracking". It is not zero: zero is
   a claim that the cash was free. */
ALTER TABLE ledger_till_balances
  ADD COLUMN IF NOT EXISTS avg_cost numeric(24,12)
    CHECK (avg_cost IS NULL OR avg_cost >= 0);

ALTER TABLE ledger_vault_balances
  ADD COLUMN IF NOT EXISTS avg_cost numeric(24,12)
    CHECK (avg_cost IS NULL OR avg_cost >= 0);

/* What the desk actually earned on a transaction: proceeds minus the cost
   of what left. Negative is a real loss and is stored as one. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS realized_pnl_home numeric(24,2),
  ADD COLUMN IF NOT EXISTS cost_of_sale_home numeric(24,2);

/* Every movement of an average, in order, with its arithmetic exposed.

   This is the audit trail AND the mechanism: a reversal reads the event it
   is undoing and inverts it, restoring units at the cost they left at.
   That cannot be done from a balance alone — the balance has forgotten. */
CREATE TABLE IF NOT EXISTS ledger_cost_events (
  event_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  /* which box: a till carries its own average, the vault carries its own,
     because a float is a movement of specific cash */
  location_kind text NOT NULL CHECK (location_kind IN ('till', 'vault')),
  location_id text NOT NULL,
  currency char(3) NOT NULL,
  /* what happened to the basis */
  event_kind text NOT NULL CHECK (event_kind IN (
    'opening',          -- stated when the desk went live
    'opening_estimated',-- stated without a cost; board mid applied
    'purchase',         -- a customer sold us this currency
    'delivery',         -- a wholesale or bank receipt
    'transfer_in',      -- a float, a return, or a run arriving
    'transfer_out',     -- the sending side of the same
    'sale',             -- sold to a customer; realizes P&L
    'withdrawal',       -- banked or otherwise disposed of
    'reversal'          -- an earlier event undone
  )),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  quantity numeric(24,2) NOT NULL CHECK (quantity > 0),
  /* the unit cost applied by THIS event: what was paid on the way in, or
     the average that was carried out on the way out */
  unit_cost_home numeric(24,12) NOT NULL CHECK (unit_cost_home >= 0),
  /* the average before and after, so the arithmetic can be checked without
     replaying the entire history */
  avg_cost_before numeric(24,12),
  avg_cost_after numeric(24,12),
  quantity_before numeric(24,2) NOT NULL,
  quantity_after numeric(24,2) NOT NULL,
  /* set only on a disposal */
  proceeds_home numeric(24,2),
  realized_pnl_home numeric(24,2),
  /* what caused it — a transaction, a cash movement, a vault movement */
  source_kind text NOT NULL,
  source_id text,
  /* the event this one undoes, for a reversal */
  reverses_event_id text REFERENCES ledger_cost_events(event_id),
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_cost_events_location_idx
  ON ledger_cost_events (
    tenant_id, legal_entity_id, branch_id, location_kind, location_id,
    currency, created_at DESC
  );

CREATE INDEX IF NOT EXISTS ledger_cost_events_source_idx
  ON ledger_cost_events (source_kind, source_id);

DROP TRIGGER IF EXISTS ledger_cost_events_immutable ON ledger_cost_events;
CREATE TRIGGER ledger_cost_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_cost_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
