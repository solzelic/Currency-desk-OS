/* ============================================================
   Jurisdiction packs — taking Canada out of the wiring.

   The book was built for one country and says so in its column names:
   fee_cad, spread_cad, amount_cad, units_per_cad. A desk in London cannot
   use a ledger whose idea of money is Canadian, and the goal is to sell
   this anywhere by plugging in a pack.

   So a jurisdiction becomes a thing you install: what currency the books
   are kept in, who the regulator is, what has to be reported and over what
   amount, and which deals are allowed. A legal entity points at one, and
   the version it points at is snapshotted onto everything it posts, so
   changing a pack later can never rewrite what already happened.

   This is step one of the non-destructive migration in
   docs/JURISDICTION_PACK_ARCHITECTURE.md: add the tables and the nullable
   generalized columns, seed the packs, backfill. Nothing is renamed and
   nothing is retired here — the CAD-named columns keep working, and the
   generalized ones become authoritative only after they have been read
   alongside them and reconciled.
   ============================================================ */

CREATE TABLE IF NOT EXISTS jurisdiction_packs (
  pack_id text PRIMARY KEY,
  jurisdiction text NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  /* the currency this jurisdiction's desks keep their books in. Every cost,
     every margin, every journal line is measured in it. */
  home_currency char(3) NOT NULL,
  regulator text NOT NULL,
  /* what a desk here must report, and over what */
  report_name text NOT NULL,
  report_threshold numeric(24,2) NOT NULL,
  id_threshold numeric(24,2) NOT NULL,
  report_currency char(3) NOT NULL,
  /* CAPABILITY, not law: whether a desk here may trade one foreign currency
     for another without the home currency in the middle. The pilot could
     not, which is why the original design wrote it down as a rejection —
     but a customer arriving with dollars and wanting euros is ordinary
     business, so it is a switch on the pack rather than a rule in the code. */
  allow_cross_currency boolean NOT NULL DEFAULT true,
  /* currencies a desk in this jurisdiction may enable. Empty means no
     restriction beyond what the desk itself turns on. */
  permitted_currencies jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (jurisdiction, version)
);

/* A legal entity is what actually has a jurisdiction — the MSB registration
   already lives there, and one tenant can hold entities in more than one
   country. */
ALTER TABLE legal_entities
  ADD COLUMN IF NOT EXISTS home_currency char(3),
  ADD COLUMN IF NOT EXISTS jurisdiction_pack_id text REFERENCES jurisdiction_packs(pack_id),
  ADD COLUMN IF NOT EXISTS jurisdiction_pack_version integer;

/* ---- the packs themselves ----
   Thresholds are the reporting figures each regulator actually uses.
   A pack is versioned: when a threshold changes, a new version is added
   and entities are moved to it deliberately — history keeps pointing at
   the version it was posted under. */
INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency)
VALUES
  ('pack-ca-v1', 'CA', 1, 'Canada', 'CAD', 'FINTRAC', 'LCTR', 10000, 3000, 'CAD'),
  ('pack-us-v1', 'US', 1, 'United States', 'USD', 'FinCEN', 'CTR', 10000, 3000, 'USD'),
  ('pack-gb-v1', 'GB', 1, 'United Kingdom', 'GBP', 'HMRC', 'MLR', 10000, 1000, 'GBP'),
  ('pack-eu-v1', 'EU', 1, 'Eurozone', 'EUR', 'AMLD', 'STR', 10000, 1000, 'EUR'),
  ('pack-au-v1', 'AU', 1, 'Australia', 'AUD', 'AUSTRAC', 'TTR', 10000, 1000, 'AUD'),
  ('pack-ae-v1', 'AE', 1, 'United Arab Emirates', 'AED', 'CBUAE', 'STR', 55000, 3500, 'AED')
ON CONFLICT (pack_id) DO NOTHING;

/* Everything that exists today was created under the Canadian pilot, and
   its books really are in Canadian dollars — so this states what is already
   true rather than deciding anything new. */
UPDATE legal_entities
   SET home_currency = 'CAD',
       jurisdiction_pack_id = 'pack-ca-v1',
       jurisdiction_pack_version = 1
 WHERE home_currency IS NULL;

/* ---- generalized money columns, added alongside the CAD-named ones ----
   Nothing reads these as authoritative yet. They are written in parallel so
   the two can be compared over a release before the old ones are retired,
   which is the only safe way to move a live book off a hardcoded currency. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS home_currency char(3),
  ADD COLUMN IF NOT EXISTS fee_amount numeric(24,2),
  ADD COLUMN IF NOT EXISTS fee_currency char(3),
  ADD COLUMN IF NOT EXISTS spread_home_amount numeric(24,2),
  ADD COLUMN IF NOT EXISTS jurisdiction_pack_id text,
  ADD COLUMN IF NOT EXISTS jurisdiction_pack_version integer;

ALTER TABLE ledger_journal_entries
  ADD COLUMN IF NOT EXISTS amount_home numeric(24,2),
  ADD COLUMN IF NOT EXISTS home_currency char(3);

/* Backfill: for every row that exists, the home currency was CAD and the
   generalized value is the CAD value. Non-destructive — the source columns
   are untouched. */
UPDATE ledger_transactions
   SET home_currency = COALESCE(home_currency, 'CAD'),
       fee_amount = COALESCE(fee_amount, fee_cad),
       fee_currency = COALESCE(fee_currency, 'CAD'),
       spread_home_amount = COALESCE(spread_home_amount, spread_cad),
       jurisdiction_pack_id = COALESCE(jurisdiction_pack_id, 'pack-ca-v1'),
       jurisdiction_pack_version = COALESCE(jurisdiction_pack_version, 1)
 WHERE home_currency IS NULL;

UPDATE ledger_journal_entries
   SET amount_home = COALESCE(amount_home, amount_cad),
       home_currency = COALESCE(home_currency, 'CAD')
 WHERE home_currency IS NULL;

CREATE INDEX IF NOT EXISTS legal_entities_pack_idx
  ON legal_entities (jurisdiction_pack_id);
