/* ============================================================
   Choosing how inventory is costed — weighted average or FIFO.

   The desk has costed inventory by weighted average since cost tracking
   existed. Both weighted average and FIFO are legitimate for fungible
   inventory, they report different profit in the short run on the same
   trades, and which one a desk uses is the desk's decision. It is NOT a
   jurisdiction rule: a pack may suggest a default, but an owner in any
   country may run FIFO if they want to.

   So two columns. `jurisdiction_packs.default_cost_method` is the
   suggestion; `legal_entities.cost_method` is what this desk actually
   uses, and NULL there means "whatever the pack suggests". The override
   is the whole point — it is what makes this the owner's choice rather
   than their country's.

   ---- why lots exist under BOTH methods ----

   A lot is one acquisition: how much arrived, what a unit of it cost,
   and how much of it is left. FIFO prices a sale by walking those lots
   oldest first. Weighted average does not need them to price anything.

   They are maintained anyway, always. If lots were kept only while FIFO
   was switched on, a desk turning it on after a year of trading would
   have no acquisition history to compute from, and the first sale would
   have to invent one. Keeping them always costs one row per purchase and
   makes the switch honest whenever it happens.

   See docs/COST_BASIS.md.
   ============================================================ */

/* What a country's pack SUGGESTS. Every pack shipped today suggests
   weighted average — deliberately, because this migration must not
   restate anybody's books. A pack that changes this later moves only the
   desks that have not made their own choice, and a desk that has is
   never moved by a pack at all. */
ALTER TABLE jurisdiction_packs
  ADD COLUMN IF NOT EXISTS default_cost_method text NOT NULL
    DEFAULT 'weighted_average';

ALTER TABLE jurisdiction_packs
  DROP CONSTRAINT IF EXISTS jurisdiction_packs_default_cost_method_check;
ALTER TABLE jurisdiction_packs
  ADD CONSTRAINT jurisdiction_packs_default_cost_method_check
    CHECK (default_cost_method IN ('weighted_average', 'fifo'));

/* What this desk ACTUALLY uses. NULL is not a missing value — it means
   "follow the pack", which is the state a desk starts in and stays in
   until somebody deliberately decides otherwise. */
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS cost_method text;

ALTER TABLE legal_entities
  DROP CONSTRAINT IF EXISTS legal_entities_cost_method_check;
ALTER TABLE legal_entities
  ADD CONSTRAINT legal_entities_cost_method_check
    CHECK (cost_method IS NULL OR cost_method IN ('weighted_average', 'fifo'));

/* Which method priced a disposal. Without it, a book containing sales
   from both sides of a switch cannot say which line was costed how —
   and "why is this month's margin different" becomes unanswerable.
   NULL on rows written before this existed, and on acquisitions, which
   are not priced against anything. */
ALTER TABLE ledger_cost_events
  ADD COLUMN IF NOT EXISTS cost_method text;

ALTER TABLE ledger_cost_events
  DROP CONSTRAINT IF EXISTS ledger_cost_events_cost_method_check;
ALTER TABLE ledger_cost_events
  ADD CONSTRAINT ledger_cost_events_cost_method_check
    CHECK (cost_method IS NULL OR cost_method IN ('weighted_average', 'fifo'));

/* ---- the lots ----

   One row per acquisition, per box, per currency. `quantity` is what
   arrived and never changes; `remaining_quantity` is what is left of it
   and is drawn down by every disposal, under either method, so the two
   together read as "we bought this, and this much of it is still here". */
CREATE TABLE IF NOT EXISTS ledger_cost_lots (
  lot_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  /* the same box identity the balances and the cost events use: a till
     and a vault each hold their own stock and each cost it separately */
  location_kind text NOT NULL CHECK (location_kind IN ('till', 'vault')),
  location_id text NOT NULL,
  currency char(3) NOT NULL,
  quantity numeric(24,2) NOT NULL CHECK (quantity > 0),
  unit_cost_home numeric(24,12) NOT NULL CHECK (unit_cost_home >= 0),
  remaining_quantity numeric(24,2) NOT NULL CHECK (remaining_quantity >= 0),
  /* what FIFO orders by. Not created_at: a lot can be written after the
     fact, and the order that matters is the order the cash arrived in. */
  acquired_at timestamptz NOT NULL,
  /* the acquisition event that opened this lot. NULL only for a lot
     reconstructed from a balance that predates lot tracking — there is
     no event behind those because none was ever written, and that is a
     state somebody can find rather than one that passes as fact. */
  event_id text REFERENCES ledger_cost_events(event_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_cost_lots_remaining_within_quantity
    CHECK (remaining_quantity <= quantity)
);

/* The read FIFO actually performs: the open lots of one box and currency,
   oldest first. Partial, because a closed lot is never a candidate and a
   busy desk accumulates far more closed lots than open ones. */
CREATE INDEX IF NOT EXISTS ledger_cost_lots_open_idx
  ON ledger_cost_lots (
    tenant_id, legal_entity_id, branch_id, location_kind, location_id,
    currency, acquired_at, lot_id
  )
  WHERE remaining_quantity > 0;

CREATE INDEX IF NOT EXISTS ledger_cost_lots_event_idx
  ON ledger_cost_lots (event_id);

/* Which lots a disposal drew from, and how much of each. This is what
   lets somebody explain a FIFO cost of sale line by line — and it is
   also the mechanism a reversal runs backwards, because a lot's
   remaining quantity alone has forgotten who took from it.

   Written under weighted average too. The units physically came out of
   some lot either way; what differs is only whether the event was priced
   against them. */
CREATE TABLE IF NOT EXISTS ledger_cost_lot_consumption (
  consumption_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES ledger_cost_events(event_id),
  lot_id text NOT NULL REFERENCES ledger_cost_lots(lot_id),
  quantity numeric(24,2) NOT NULL CHECK (quantity > 0),
  unit_cost_home numeric(24,12) NOT NULL CHECK (unit_cost_home >= 0),
  cost_home numeric(24,2) NOT NULL,
  /* set when a reversal puts these units back. Rows are never deleted,
     so a second reversal of the same event cannot restore them twice. */
  reversed_by_event_id text REFERENCES ledger_cost_events(event_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_cost_lot_consumption_event_idx
  ON ledger_cost_lot_consumption (event_id);

CREATE INDEX IF NOT EXISTS ledger_cost_lot_consumption_lot_idx
  ON ledger_cost_lot_consumption (lot_id);

/* ---- one-time reconstruction of what is already in the boxes ----

   Every balance carrying an average today was bought at some point, but
   the acquisitions behind it were never recorded as lots. Left alone, a
   desk switching to FIFO tomorrow would find no lots for stock it really
   holds and price the sale against nothing — booking the entire proceeds
   as profit, which is the exact failure the cost basis work exists to
   prevent.

   So the balance becomes one lot at the average it currently carries.
   That average is the best figure that exists for this cash; it is not a
   guess, it is what the book already says the stock cost. `event_id` is
   left NULL to mark it as reconstructed rather than observed.

   Guarded by NOT EXISTS so re-running against a database that already
   has lots cannot duplicate the position. */
INSERT INTO ledger_cost_lots
  (lot_id, tenant_id, legal_entity_id, branch_id, location_kind,
   location_id, currency, quantity, unit_cost_home, remaining_quantity,
   acquired_at, event_id)
SELECT
  'lot_backfill_till_' || md5(
    b.tenant_id || ':' || b.legal_entity_id || ':' || b.branch_id || ':' ||
    b.till_id || ':' || b.currency),
  b.tenant_id, b.legal_entity_id, b.branch_id, 'till', b.till_id, b.currency,
  b.available_amount, b.avg_cost, b.available_amount, now(), NULL
  FROM ledger_till_balances b
 WHERE b.avg_cost IS NOT NULL
   AND b.available_amount > 0
   AND NOT EXISTS (
     SELECT 1 FROM ledger_cost_lots l
      WHERE l.tenant_id = b.tenant_id
        AND l.legal_entity_id = b.legal_entity_id
        AND l.branch_id = b.branch_id
        AND l.location_kind = 'till'
        AND l.location_id = b.till_id
        AND l.currency = b.currency)
ON CONFLICT (lot_id) DO NOTHING;

INSERT INTO ledger_cost_lots
  (lot_id, tenant_id, legal_entity_id, branch_id, location_kind,
   location_id, currency, quantity, unit_cost_home, remaining_quantity,
   acquired_at, event_id)
SELECT
  'lot_backfill_vault_' || md5(
    v.tenant_id || ':' || v.legal_entity_id || ':' || v.branch_id || ':' ||
    v.currency),
  v.tenant_id, v.legal_entity_id, v.branch_id, 'vault', v.branch_id, v.currency,
  v.available_amount, v.avg_cost, v.available_amount, now(), NULL
  FROM ledger_vault_balances v
 WHERE v.avg_cost IS NOT NULL
   AND v.available_amount > 0
   AND NOT EXISTS (
     SELECT 1 FROM ledger_cost_lots l
      WHERE l.tenant_id = v.tenant_id
        AND l.legal_entity_id = v.legal_entity_id
        AND l.branch_id = v.branch_id
        AND l.location_kind = 'vault'
        AND l.currency = v.currency)
ON CONFLICT (lot_id) DO NOTHING;
