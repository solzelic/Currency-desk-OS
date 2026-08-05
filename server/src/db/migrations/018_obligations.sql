/* ============================================================
   The four remaining deal types, and the money they owe.

   Migration 017 brought cheque cashing across and set the shape: a
   transaction row says what KIND of deal it is and what physically
   changed hands, and the thing the desk is left holding afterwards gets
   a table of its own. This migration follows it for the other four —
   remittance send, remittance receive, bill payment and money order —
   which between them were the largest hole in the book. Five of six
   lines moved drawer cash on screen and stopped there; a desk that did
   twenty remittances closed the day with a till that disagreed with its
   own ledger by whatever it had taken in, and nothing crashed, because
   two books never do.

   ---- WHAT THESE FOUR HAVE IN COMMON ----

   Each one is cash on one side and a PROMISE on the other:

     remittance send      cash in,  the desk owes a payout abroad
     remittance receive   cash out, a corridor partner owes the desk
     bill payment         cash in,  the desk owes a biller
     money order          cash in,  the desk owes whoever presents it

   That promise is real money. Forty open remittances are forty payouts
   the desk has to fund, and until now that figure existed only as a
   status field in a browser store — which is to say it did not exist.
   `ledger_obligations` is where it lives.

   ---- WHY AN OBLIGATION CARRIES TWO AMOUNTS ----

   `face_amount` in `face_currency` is what must be delivered, in the
   currency it must be delivered in: 24,000 pesos, or 150 dollars to a
   hydro company.

   `carrying_amount_home` is what the book says that promise is worth,
   and it is what was ACTUALLY given up for it — the cash the customer
   handed over, or the cash the desk paid a beneficiary. It is NOT a
   translation of the face at a market mid.

   That distinction is the whole design. The desk's margin on a
   remittance is in the rate as well as the fee, but the rate side of it
   is not knowable at the counter: the desk sells pesos at its own price
   and buys them from the corridor partner at the partner's, and the
   product does not carry the partner's price — `corridors[].partners[]`
   in os-src/cdos-transfers.jsx holds a name, a list of payout methods
   and an ETA, and no cost of any kind. Booking a margin at send time
   would therefore mean measuring against the market mid, which is
   precisely the `revenue:fx_spread` estimate docs/COST_BASIS.md records
   the deletion of: a spread against a reference price nobody paid. So
   the margin appears at SETTLEMENT, when the real price is known, and
   not one moment earlier. See docs/OBLIGATION_LINES.md.

   ---- WHAT THIS ADDS TO ledger_transactions ----

   Migration 017's `deal_kind`, `received_instrument` and
   `disbursed_instrument` already say what a row is and what changed
   hands, and this migration widens all three rather than inventing a
   parallel vocabulary — one table with two ways of saying "cash came in"
   is how the disagreements start.

   Two columns are genuinely new. `cash_in_home` and `cash_out_home` are
   the home-currency size of the cash that actually crossed the counter,
   which the amount columns cannot give: on a remittance receive
   `input_amount` is the foreign sum a sender abroad dispatched and the
   cash that changed hands is the smaller home-currency payout. A large
   cash report built on the wrong one of those is wrong in the direction
   that gets a desk fined.

   Nothing here goes into the DDL constant in server/src/db/index.ts.
   That constant builds the embedded PGlite database, which carries no
   ledger tables at all — `ledger_transactions` itself is created by
   src/ledger/migration.sql and has never been in it.
   ============================================================ */

/* ---- widen what a transaction row may say it is ----

   Four new deal kinds, and one for each way an obligation ends. A
   settlement is not a deal — counting it as one would let a single
   remittance appear twice in a day's volume — which is the same
   distinction 017 drew between `cheque_cashing` and `cheque_clearing`.

   Constraints are dropped and recreated rather than widened in place
   because PostgreSQL has no ALTER CONSTRAINT for a CHECK, and doing it
   under the original names keeps ONE constraint per rule. A second
   constraint with a new name would leave the old one still refusing
   everything it was written before. */
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_deal_kind_check;
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_deal_kind_check
  CHECK (deal_kind IN (
    'exchange',
    'cheque_cashing', 'cheque_clearing', 'cheque_return',
    'remittance_send', 'remittance_receive',
    'bill_payment', 'money_order',
    /* how an obligation ended. `obligation_settlement` covers all four
       lines because the journal is the same shape whatever opened it;
       the obligation row says which line it was. */
    'obligation_settlement', 'obligation_write_off'));

/* Three more instruments. A remittance leaves the desk as a wire to a
   corridor partner, a money order leaves as the instrument itself, and a
   bill payment leaves as a credit to somebody's account — none of which
   is cash, a cheque or a bank credit to the desk. */
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_instrument_check;
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_counter_instruments_check;
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_counter_instruments_check
  CHECK (
    received_instrument IN ('cash', 'cheque', 'bank_credit', 'electronic_funds_transfer', 'money_order', 'bill_credit', 'none')
    AND disbursed_instrument IN ('cash', 'cheque', 'bank_credit', 'electronic_funds_transfer', 'money_order', 'bill_credit', 'none'));

/* ---- how much cash, in the currency the book is kept in ----

   Left NULL on every row already posted. The figure could be
   reconstructed from the legs and the mids of the day, and a
   reconstructed figure that looks like a recorded one is exactly what
   docs/ABSENT_FIGURES.md exists to forbid. Absent, visibly. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS cash_in_home numeric(24,2),
  ADD COLUMN IF NOT EXISTS cash_out_home numeric(24,2),
  /* Whether the value left the country. An electronic funds transfer
     report has its own rules for cross-border movements and they are
     not the large-cash rules, so the engine is handed the fact rather
     than being left to infer it from a payout currency — a peso payout
     and a US dollar payout are both cross-border, and a Canadian desk
     paying Canadian dollars into a Canadian account is not. Defaults to
     false, which is true of every exchange already on the book. */
  ADD COLUMN IF NOT EXISTS cross_border boolean NOT NULL DEFAULT false;

/* Dropped and re-added rather than guarded by `IF NOT EXISTS (… conname
   = …)`. That guard is how a constraint silently fails to be created —
   017 hit it from the other side and renamed its own constraint so this
   migration could not skip past a stale one — and a rule that quietly
   did not get applied is worse than no rule, because everything
   downstream is written as though it had been. */
ALTER TABLE ledger_transactions DROP CONSTRAINT IF EXISTS ledger_transactions_cash_home_check;
ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_cash_home_check
  CHECK ((cash_in_home IS NULL OR cash_in_home >= 0)
     AND (cash_out_home IS NULL OR cash_out_home >= 0));

/* ---- what the desk owes, and what is owed to the desk ---- */

CREATE TABLE IF NOT EXISTS ledger_obligations (
  obligation_id text PRIMARY KEY,
  /* the desk's own human reference — TR-260618-003, MO-260618-011 — what
     staff quote to each other and what the customer is holding. */
  obligation_ref text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  customer_id text NOT NULL,
  /* the deal that created it. One obligation per transaction: an
     obligation with no deal behind it is a number somebody typed. */
  transaction_id text NOT NULL UNIQUE REFERENCES ledger_transactions(transaction_id),
  kind text NOT NULL CHECK (kind IN (
    'remittance_payable', 'remittance_receivable', 'bill_payable', 'money_order_payable')),
  /* payable: the desk owes. receivable: the desk is owed. Redundant with
     `kind` today and kept separate anyway, because the sign of an
     obligation is the one thing a reader must never have to infer from a
     name. */
  direction text NOT NULL CHECK (direction IN ('payable', 'receivable')),
  /* who it is with — a corridor partner, a biller, a named payee. Free
     text because the desk's partners are not modelled on the server, and
     inventing a partner table to hold a name would be starting from the
     wrong end. */
  counterparty text NOT NULL,
  /* the corridor reference, the biller's account number, the money
     order's serial — whatever identifies this obligation to the person
     who has to honour it. */
  reference text,
  /* the destination country of a cross-border line, ISO-3166 alpha-2, or
     NULL for a domestic one. `cross_border` on the transaction is the
     fact a report reasons from; this is the corridor the desk trades. */
  corridor char(2),
  face_currency char(3) NOT NULL,
  face_amount numeric(24,2) NOT NULL CHECK (face_amount > 0),
  home_currency char(3) NOT NULL,
  carrying_amount_home numeric(24,2) NOT NULL CHECK (carrying_amount_home > 0),
  /* held      — open, the promise stands
     settled   — discharged, and `settled_amount_home` says for how much
     written_off — the counterparty did not perform and the desk took the
                 loss. A very different thing from `reversed`, which is
                 why it is a different status and not a flag: a write-off
                 is money genuinely lost, a reversal is a deal that never
                 happened. */
  status text NOT NULL CHECK (status IN ('open', 'settled', 'written_off', 'reversed')),
  /* what discharging it actually cost, or actually brought in. Known
     only at settlement, NULL until then — never a market translation
     standing in for a price. */
  settled_amount_home numeric(24,2),
  settled_at timestamptz,
  /* the ledger rows this obligation's life produced */
  settlement_transaction_id text REFERENCES ledger_transactions(transaction_id),
  reversal_id text REFERENCES ledger_reversals(reversal_id),
  opened_at timestamptz NOT NULL,
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_obligations_ref_idx
  ON ledger_obligations (tenant_id, legal_entity_id, branch_id, obligation_ref);
CREATE INDEX IF NOT EXISTS ledger_obligations_open_idx
  ON ledger_obligations (tenant_id, legal_entity_id, branch_id, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS ledger_obligations_counterparty_idx
  ON ledger_obligations (tenant_id, legal_entity_id, counterparty, status);

/* ---- how it got there ----

   The status column says where the obligation IS. This says how it got
   there, and it is append-only for the same reason the journal is: a
   settlement that was later disputed, or a write-off somebody reversed,
   is exactly the history an examiner asks about. */
CREATE TABLE IF NOT EXISTS ledger_obligation_events (
  event_id text PRIMARY KEY,
  obligation_id text NOT NULL REFERENCES ledger_obligations(obligation_id),
  kind text NOT NULL CHECK (kind IN ('opened', 'settled', 'written_off', 'reversed')),
  /* the ledger row this step posted, where it posted one. A settlement
     and a write-off each write a journal; the opening names the deal. */
  transaction_id text REFERENCES ledger_transactions(transaction_id),
  amount_home numeric(24,2) NOT NULL CHECK (amount_home >= 0),
  /* carrying − amount, signed: positive is the desk's margin on a
     payable discharged for less than it was carried at, negative is a
     loss. Stored rather than recomputed for the reason
     docs/COST_BASIS.md gives for storing a cost of sale: one event, one
     figure, and nothing downstream gets a second opinion. */
  margin_home numeric(24,2) NOT NULL DEFAULT 0,
  reference text,
  reason text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_obligation_events_obligation_idx
  ON ledger_obligation_events (obligation_id, created_at);

DROP TRIGGER IF EXISTS ledger_obligation_events_immutable ON ledger_obligation_events;
CREATE TRIGGER ledger_obligation_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_obligation_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
