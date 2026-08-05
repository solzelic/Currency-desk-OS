/* ============================================================
   Cheque cashing, on the book.

   Five of the six deal types this product sells moved drawer cash without
   ever reaching the server: cheque cashing, pay out, money orders, bill
   payment and remittance. The browser built a row, pushed it into an
   array, and the ledger never heard about any of it. This is the first of
   the five to come across, so the shape here is the shape the rest will
   follow.

   ---- WHY A CHEQUE IS NOT A SALE ----

   Cashing a cheque is the desk FRONTING cash against a receivable it hopes
   will clear. The customer walks out with money; what the desk is holding
   is a piece of paper and somebody else's promise. That is credit risk,
   and a journal that books it as a sale cannot tell you how much of the
   desk's cash is currently out of the door on paper that has not cleared —
   which is the only question that matters about this product line.

   So a cashing opens a receivable (`asset:cheques_held`) and the two
   later events close it: the bank pays (`asset:bank_clearing`) or the
   cheque comes back (`expense:cheque_losses`). See docs/CHEQUE_CASHING.md
   for the three journals and the worked example.

   ---- WHAT THIS MIGRATION ADDS ----

   Two tables — the cheque itself and its status timeline — and three
   columns on `ledger_transactions` that say what KIND of thing a
   transaction row is and what physically changed hands. Those three exist
   because the book now carries rows that are not exchanges, and every
   consumer downstream had been entitled to assume they all were.

   Nothing here goes into the DDL constant in server/src/db/index.ts. That
   constant builds the embedded PGlite database, which carries no ledger
   tables at all — `ledger_transactions` itself is created by
   src/ledger/migration.sql and has never been in it. Migration 015 is the
   recent precedent for a ledger-only change that correctly needed no DDL
   edit.
   ============================================================ */

/* ---- what kind of thing a transaction row is ----

   Every row in this table used to be an over-the-counter currency
   exchange, so nothing ever had to say so. Now it does: a cheque cashing
   is a deal, and a clearance or a return is a SETTLEMENT of a deal that
   already happened. Counting the second kind as deals would let one
   cheque appear three times in a day's volume.

   The default is applied so existing rows — all of them exchanges — get
   the truth, and then dropped so that every future INSERT has to say what
   it is. A default that quietly stands in for a missing value is exactly
   how the compliance worksheet came to assert "Method of transaction:
   Cash" about deals that were nothing of the sort. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS deal_kind text NOT NULL DEFAULT 'exchange';
ALTER TABLE ledger_transactions ALTER COLUMN deal_kind DROP DEFAULT;

/* ---- what physically changed hands ----

   A compliance engine asking "did this desk RECEIVE a large amount of
   cash" needs a true answer, and the amount columns cannot give it one: a
   cashed cheque has `from_currency` CAD and `input_amount` 1,000 and not
   one dollar of cash came in. These two columns say what actually arrived
   at the counter and what actually left it, which is a fact about the
   transaction rather than an inference from its shape.

   Deliberately NOT a reporting decision. Whether a cashed cheque creates
   an obligation, and which one, is a jurisdiction question that belongs
   to the packs — see the note at the foot of
   src/db/migrations/012_jurisdiction_reports.sql about transcribing
   somebody else's paperwork rather than guessing at it. What this
   migration does is stop the engine having to guess at the FACT. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS received_instrument text NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS disbursed_instrument text NOT NULL DEFAULT 'cash';
ALTER TABLE ledger_transactions ALTER COLUMN received_instrument DROP DEFAULT;
ALTER TABLE ledger_transactions ALTER COLUMN disbursed_instrument DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_transactions_deal_kind_check'
  ) THEN
    ALTER TABLE ledger_transactions
      ADD CONSTRAINT ledger_transactions_deal_kind_check
      CHECK (deal_kind IN ('exchange', 'cheque_cashing', 'cheque_clearing', 'cheque_return'));
  END IF;
  /* Named for the counter rather than for "instrument" on purpose. The
     sibling migration bringing the other four deal lines across
     (018_obligations.sql) adds its own single `instrument` column with a
     constraint it wanted to call `ledger_transactions_instrument_check`,
     and because both guards are `IF NOT EXISTS (… conname = …)` the second
     one to run would find the name taken and skip silently — leaving a
     money column with no constraint on it and nothing in either file to
     say why. Two different facts, two different names.

     The overlap itself is real and is NOT resolved here: that migration's
     `deal_type` and this one's `deal_kind` are the same question asked
     twice. Whoever lands the second of the two owes the table one column,
     and the reconciliation is named in the handoff rather than guessed at
     by whichever of us happened to be writing at the time. */
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_transactions_counter_instruments_check'
  ) THEN
    ALTER TABLE ledger_transactions
      ADD CONSTRAINT ledger_transactions_counter_instruments_check
      CHECK (
        received_instrument IN ('cash', 'cheque', 'bank_credit', 'none')
        AND disbursed_instrument IN ('cash', 'cheque', 'bank_credit', 'none')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ledger_transactions_deal_kind_idx
  ON ledger_transactions (tenant_id, legal_entity_id, branch_id, deal_kind);

/* ---- the cheque ----

   Outstanding exposure — cash out of the door that has not cleared — is a
   money question, and it lived in one browser's localStorage under
   `cdos_cheques_v1`. That store dies with the browser profile, the second
   till holds a different set of cheques from the first, and the figure it
   feeds ("Cash at risk") is the desk's own credit exposure. Same story as
   the filed reports in migration 015, and the same answer: the ledger is
   the record and the browser keeps a cache.

   The image is NOT here, deliberately. Cheque and identity images are
   being dealt with separately — there is a ceiling on intake now, see
   tests/e2e/id-intake-seam.spec.ts — and moving a base64 photograph into
   this table in the same change that moves the money would put a megabyte
   of JPEG inside a SERIALIZABLE money transaction. The image stays in the
   browser for now and the cheque record says nothing about it. */
CREATE TABLE IF NOT EXISTS ledger_cheques (
  cheque_id text PRIMARY KEY,
  /* the desk's own human reference, CHQ-260618-002 — what staff quote to
     each other and to the customer */
  cheque_ref text NOT NULL,
  tenant_id text NOT NULL,
  legal_entity_id text NOT NULL,
  branch_id text NOT NULL,
  workspace_id text NOT NULL,
  till_id text NOT NULL,
  customer_id text NOT NULL,
  /* the paper: who wrote it, on which bank, and its number */
  cheque_number text NOT NULL,
  maker text NOT NULL,
  drawee_bank text,
  /* the desk's own fee-schedule row this was priced from ('payroll',
     'personal'…) and the label it showed the teller. The schedule itself
     is still the desk's to set; what is recorded here is which line of it
     was applied, so a fee can be explained a year later even after the
     schedule has moved. */
  cheque_type text NOT NULL,
  type_label text NOT NULL,
  /* IN SCOPE: the desk's home currency only. A foreign-currency cheque is
     an exchange AND a cheque and has to go through the quote path, so the
     service refuses one outright rather than mis-posting it. The column
     is here because a cheque has a currency whatever we currently allow,
     and a table that could not express the refused case would make the
     refusal impossible to test. */
  currency char(3) NOT NULL,
  face_amount numeric(24,2) NOT NULL CHECK (face_amount > 0),
  fee_amount numeric(24,2) NOT NULL CHECK (fee_amount >= 0),
  net_amount numeric(24,2) NOT NULL CHECK (net_amount >= 0),
  /* The cashing journal balances BECAUSE face = net + fee. That is not a
     coincidence to be re-derived in the service and hoped about; the
     database refuses a cheque whose three figures do not add up, so a
     rounding bug upstream cannot become an unbalanced journal. */
  CONSTRAINT ledger_cheques_face_check CHECK (face_amount = net_amount + fee_amount),
  hold_days integer NOT NULL DEFAULT 0 CHECK (hold_days >= 0),
  hold_until date NOT NULL,
  received_date date NOT NULL,
  endorsed boolean NOT NULL DEFAULT false,
  /* held     — cash is out, the paper has not settled either way
     cleared  — the drawee bank paid; the receivable became bank funds
     returned — it bounced; the desk is out the face amount
     reversed — the cashing itself was a mistake and was undone. A very
                different thing from `returned`, which is why it is a
                different status and not a flag on one: an NSF is money
                genuinely lost and a reversal is a deal that never
                happened. */
  status text NOT NULL CHECK (status IN ('held', 'cleared', 'returned', 'reversed')),
  nsf boolean NOT NULL DEFAULT false,
  fraud boolean NOT NULL DEFAULT false,
  returned_reason text,
  /* the three ledger rows this cheque's life produced */
  cashing_transaction_id text NOT NULL REFERENCES ledger_transactions(transaction_id),
  settlement_transaction_id text REFERENCES ledger_transactions(transaction_id),
  reversal_id text REFERENCES ledger_reversals(reversal_id),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_cheques_ref_idx
  ON ledger_cheques (tenant_id, legal_entity_id, branch_id, cheque_ref);
CREATE INDEX IF NOT EXISTS ledger_cheques_scope_idx
  ON ledger_cheques (tenant_id, legal_entity_id, branch_id, status, received_date DESC);
/* One cashing, one cheque. A retried request that slipped past the
   idempotency key must not be able to open a second receivable against
   the same posted transaction. */
CREATE UNIQUE INDEX IF NOT EXISTS ledger_cheques_cashing_idx
  ON ledger_cheques (cashing_transaction_id);

/* ---- who moved it, when, and why ----

   The status column says where the cheque IS. This says how it got there,
   and it is append-only for the same reason the journal is: a clearance
   that was later reversed, or a fraud flag that somebody removed, is
   exactly the history an examiner asks about. The browser already drew
   this timeline; it was drawing it from localStorage. */
CREATE TABLE IF NOT EXISTS ledger_cheque_events (
  event_id text PRIMARY KEY,
  cheque_id text NOT NULL REFERENCES ledger_cheques(cheque_id),
  status text NOT NULL CHECK (status IN ('held', 'cleared', 'returned', 'reversed')),
  actor_id text NOT NULL,
  note text,
  /* the ledger row this step posted, where it posted one. A clearance and
     a return each write a journal; the original cashing names its own. */
  transaction_id text REFERENCES ledger_transactions(transaction_id),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_cheque_events_cheque_idx
  ON ledger_cheque_events (cheque_id, created_at);

DROP TRIGGER IF EXISTS ledger_cheque_events_immutable ON ledger_cheque_events;
CREATE TRIGGER ledger_cheque_events_immutable
  BEFORE UPDATE OR DELETE ON ledger_cheque_events
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
