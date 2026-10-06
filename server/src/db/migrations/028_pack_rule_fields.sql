/* ============================================================
   Room on a pack for the rules a country actually writes down.

   A pack already had one identification number and one report number.
   That is not how the rules are written. Canada identifies a foreign
   exchange at one amount and a money transfer at another. The EU's
   2027 transfer rule is "more than", not "at least". Serbia states
   some lines in euros. A deadline can be "immediately", "within 24
   hours", "before the deal", or "by the 15th of next month", not only
   a count of days. None of that fits in the two numbers migration 011
   stored.

   This migration adds the columns and copies today's behaviour into
   them. It does not change a seeded threshold or a pack version.
   A later pack is a new row.

   It also points an existing desk that has no pack at the Canada pack
   when that desk's home currency, after upper(btrim(...)), is CAD,
   empty, or null, and it sets home_currency to CAD where that column
   was empty or null. Every other home currency is pointed at the
   international baseline, pack-intl-v1, and keeps the currency it
   already named. The known-wrong country packs are not assigned.

   The migration runner applies this file inside one transaction. If
   the aggregation guard below raises, none of this file is kept.

   Draft PR 57 owns migration 027. This is 028 so the two can land in
   either order.
   ============================================================ */

/* ---- identification, one line per kind of deal ----

   NULL means this kind of deal has no identification line.
   0 means every deal of this kind. A positive amount means identify
   at that amount. The comparator on the line says whether that is
   "at or above" (gte) or "more than" (gt).

   The single `jurisdiction_packs.id_threshold` column stays. It is
   still the number the posting gate reads. A positive value is copied
   onto every deal kind below, so the gate and this table say the same
   thing until a later pack version splits them. Zero on that old
   column means the number was never stated. It is not copied, because
   copying it would turn "unknown" into "every deal".

   `fx` is foreign exchange. `remittance` is a money transfer.
   `eft` is an electronic funds transfer. `virtual_currency` is a
   virtual-currency deal.

   diligence is how far the check goes: identify, cdd (customer due
   diligence), or edd (enhanced). cash_only means the line applies
   to cash and not to every instrument. Seeded lines are "identify",
   "at or above", and not cash-only. */
CREATE TABLE IF NOT EXISTS jurisdiction_id_thresholds (
  pack_id text NOT NULL REFERENCES jurisdiction_packs(pack_id),
  deal_kind text NOT NULL,
  threshold numeric(24,2),
  currency char(3),
  PRIMARY KEY (pack_id, deal_kind),
  CONSTRAINT jurisdiction_id_thresholds_kind_check
    CHECK (deal_kind IN ('fx', 'remittance', 'eft', 'virtual_currency')),
  CONSTRAINT jurisdiction_id_thresholds_amount_check
    CHECK (
      threshold IS NULL
      OR (threshold >= 0 AND currency IS NOT NULL)
    )
);

-- id-copy:start
INSERT INTO jurisdiction_id_thresholds (pack_id, deal_kind, threshold, currency)
SELECT p.pack_id, k.deal_kind, p.id_threshold, p.home_currency
  FROM jurisdiction_packs p
 CROSS JOIN (
   VALUES ('fx'), ('remittance'), ('eft'), ('virtual_currency')
 ) AS k(deal_kind)
 WHERE p.id_threshold > 0
ON CONFLICT (pack_id, deal_kind) DO NOTHING;
-- id-copy:end

ALTER TABLE jurisdiction_id_thresholds
  ADD COLUMN IF NOT EXISTS comparator text NOT NULL DEFAULT 'gte',
  ADD COLUMN IF NOT EXISTS diligence text NOT NULL DEFAULT 'identify',
  ADD COLUMN IF NOT EXISTS cash_only boolean NOT NULL DEFAULT false;

ALTER TABLE jurisdiction_id_thresholds
  DROP CONSTRAINT IF EXISTS jurisdiction_id_thresholds_comparator_check;
ALTER TABLE jurisdiction_id_thresholds
  ADD CONSTRAINT jurisdiction_id_thresholds_comparator_check
    CHECK (comparator IN ('gte', 'gt'));

ALTER TABLE jurisdiction_id_thresholds
  DROP CONSTRAINT IF EXISTS jurisdiction_id_thresholds_diligence_check;
ALTER TABLE jurisdiction_id_thresholds
  ADD CONSTRAINT jurisdiction_id_thresholds_diligence_check
    CHECK (diligence IN ('identify', 'cdd', 'edd'));

/* ---- what a report row still could not say ----

   deadline_value + deadline_unit: when the report is due.
     immediately       no count
     before_execution  before the deal is carried out; no count
     hours             a count of hours (24 is the common one)
     calendar_days     a count of calendar days
     business_days     a count of business days
     monthly_day       by that day of the next month (1–31)
   Both null means the pack has not stated a deadline. Nothing in the
   product computed one before this migration, so every existing row
   stays null.

   window_kind: how deals are added together before the threshold is
   tested.
     fixed_24h       the static 24-hour window the desk already uses
     calendar_month  a calendar month
     rolling_days    the last N days, and window_days is N
     banking_day     one banking day
     none            deals are not added together
   The old aggregation_hours column is left as it was. Only 24 is
   labelled fixed_24h. Anything else stops the migration, because
   labelling it fixed_24h would be a lie. Null stays none.

   comparator: gte is "at or above" (>=). gt is "more than" (>).
   Every check in the product today uses >=, so existing rows are gte.

   direction: in is cash the desk received, out is cash it paid out,
   both is either. A suspicious report has no cash direction, so it
   stays null. Large-cash reports today count cash received. Wire
   reports today count a transfer whether the desk sent it or received it.

   threshold_currency: the currency the threshold is written in. When
   it is not the pack's home currency — a euro line on a dinar book —
   the amount is converted to home currency at the rate on the deal.
   Every seeded report already states its threshold in the home
   currency, so this copies trigger_currency and no amount changes.
   This migration does not convert anything.

   cash_only: the report counts cash only. Seeded rows are not
   cash-only; the direction column already says which way the cash
   moved, and narrowing them further would change the rule. */
ALTER TABLE jurisdiction_reports
  ADD COLUMN IF NOT EXISTS deadline_value integer,
  ADD COLUMN IF NOT EXISTS deadline_unit text,
  ADD COLUMN IF NOT EXISTS window_kind text,
  ADD COLUMN IF NOT EXISTS window_days integer,
  ADD COLUMN IF NOT EXISTS comparator text,
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS threshold_currency char(3),
  ADD COLUMN IF NOT EXISTS cash_only boolean NOT NULL DEFAULT false;

-- aggregation-guard:start
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM jurisdiction_reports
   WHERE aggregation_hours IS NOT NULL
     AND aggregation_hours <> 24;
  IF bad > 0 THEN
    RAISE EXCEPTION 'jurisdiction_reports.aggregation_hours is not 24 on % row(s). Only 24 can be labelled fixed_24h. Anything else has to be named on purpose, not guessed.', bad;
  END IF;
END $$;
-- aggregation-guard:end

UPDATE jurisdiction_reports
   SET window_kind = CASE
         WHEN aggregation_hours IS NULL THEN 'none'
         WHEN aggregation_hours = 24 THEN 'fixed_24h'
       END,
       comparator = 'gte',
       direction = CASE kind
         WHEN 'large_cash' THEN 'in'
         WHEN 'wire' THEN 'both'
         ELSE NULL
       END,
       threshold_currency = trigger_currency
 WHERE window_kind IS NULL;

ALTER TABLE jurisdiction_reports
  ALTER COLUMN window_kind SET DEFAULT 'none',
  ALTER COLUMN comparator SET DEFAULT 'gte';

UPDATE jurisdiction_reports SET window_kind = 'none' WHERE window_kind IS NULL;
UPDATE jurisdiction_reports SET comparator = 'gte' WHERE comparator IS NULL;

ALTER TABLE jurisdiction_reports
  ALTER COLUMN window_kind SET NOT NULL,
  ALTER COLUMN comparator SET NOT NULL;

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_deadline_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_deadline_check
    CHECK (
      (deadline_value IS NULL AND deadline_unit IS NULL)
      OR (deadline_unit = 'immediately' AND deadline_value IS NULL)
      OR (deadline_unit = 'before_execution' AND deadline_value IS NULL)
      OR (
        deadline_unit = 'hours'
        AND deadline_value > 0
      )
      OR (
        deadline_unit IN ('calendar_days', 'business_days')
        AND deadline_value > 0
      )
      OR (
        deadline_unit = 'monthly_day'
        AND deadline_value BETWEEN 1 AND 31
      )
    );

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_window_kind_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_window_kind_check
    CHECK (window_kind IN (
      'fixed_24h', 'calendar_month', 'rolling_days', 'banking_day', 'none'
    ));

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_window_days_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_window_days_check
    CHECK (
      (window_kind = 'rolling_days' AND window_days > 0)
      OR (window_kind <> 'rolling_days' AND window_days IS NULL)
    );

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_comparator_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_comparator_check
    CHECK (comparator IN ('gte', 'gt'));

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_direction_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_direction_check
    CHECK (direction IS NULL OR direction IN ('in', 'out', 'both'));

/* ---- international baseline ----

   Not a country. A desk whose country has no pack trades under this
   row. The numbers are the stricter of the Canadian and EU lines,
   stated in US dollars, and each one cites the FATF recommendation
   it comes from. The regulator is deliberately blank: this pack does
   not name FINTRAC or any other authority.

   Full customer due diligence is 10,000 USD (FATF R.10). That figure
   is the large-cash record below. One identification row per deal
   kind cannot also store it, so the identify lines are the lower
   numbers and the 10,000 is the report.

   The market snapshot (CAD per 1 unit) converts a USD line into the
   desk's home currency at posting time. This migration does not
   convert anything itself. */
ALTER TABLE jurisdiction_packs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'country';

ALTER TABLE jurisdiction_packs
  DROP CONSTRAINT IF EXISTS jurisdiction_packs_kind_check;
ALTER TABLE jurisdiction_packs
  ADD CONSTRAINT jurisdiction_packs_kind_check
    CHECK (kind IN ('country', 'baseline'));

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  ('pack-intl-v1', 'INTL', 1, 'International baseline', 'USD', '',
   'CASH-RECORD', 10000, 3000, 'USD',
   true, 'baseline', 24, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* FATF R.10, the stricter of Canada's cash foreign-exchange line
     and the EU cash rule: identify a cash exchange at 3,000 USD or more. */
  ('pack-intl-v1', 'fx', 3000, 'USD', 'gte', 'identify', true),
  /* FATF R.16: every remittance or electronic transfer at 1,000 USD or more. */
  ('pack-intl-v1', 'remittance', 1000, 'USD', 'gte', 'identify', false),
  ('pack-intl-v1', 'eft', 1000, 'USD', 'gte', 'identify', false),
  /* FATF R.15: a virtual-currency deal at 1,000 USD or more. */
  ('pack-intl-v1', 'virtual_currency', 1000, 'USD', 'gte', 'identify', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   deadline_unit, window_kind, comparator, direction, threshold_currency, cash_only)
VALUES
  /* FATF R.10. 10,000 USD or more in a fixed 24-hour window.
     An internal record for the desk to review, not a filing to a
     named authority. Check whether the local authority requires a report. */
  ('intl-cash-record-v1', 'pack-intl-v1', 'CASH-RECORD', 'Large cash record', 'large_cash',
   10000, 'USD', 24,
   NULL, 'fixed_24h', 'gte', 'in', 'USD', true),
  /* No amount. Report to your country's financial intelligence unit
     as soon as practicable. FATF R.20. */
  ('intl-suspicious-v1', 'pack-intl-v1', 'SUSPICIOUS', 'Suspicious transaction', 'suspicious',
   NULL, NULL, NULL,
   'immediately', 'none', 'gte', NULL, NULL, false),
  /* FATF R.6. Terrorist or sanctioned property: stop the deal and
     report immediately. No sanctions list is shipped with this pack. */
  ('intl-sanctions-v1', 'pack-intl-v1', 'SANCTIONS-STOP', 'Terrorist or sanctioned property', 'other',
   NULL, NULL, NULL,
   'immediately', 'none', 'gte', NULL, NULL, false)
ON CONFLICT (report_id) DO NOTHING;

/* The market rate used to turn a USD threshold into home currency,
   and when that snapshot was fetched. Null when the line was already
   in home currency, or when no fresh rate was available. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS compliance_threshold_rate numeric(24,12),
  ADD COLUMN IF NOT EXISTS compliance_threshold_rate_at timestamptz;

/* ---- desks that were already open, and had no pack ----

   A home currency that, after upper(btrim(...)), is CAD, empty, or
   null becomes pack-ca-v1, and an empty or null home_currency is set
   to CAD, because that is the book those desks were actually keeping.

   Every other currency keeps its home currency and is pointed at the
   international baseline. Do not assign pack-gb-v1, pack-au-v1,
   pack-ae-v1, pack-eu-v1, or pack-us-v1. Those seeded numbers are
   known to be wrong, and assigning them would change live limits.

   A ledger principal that names an entity with no legal_entities row
   has no home currency to read, so it is counted and left alone.
   Running this again changes nothing: a desk that already has a pack
   is not moved, and a row this already filled is no longer null. */
-- pack-backfill:start
DO $$
DECLARE
  assigned integer := 0;
  baseline integer := 0;
  orphans integer := 0;
BEGIN
  UPDATE legal_entities
     SET jurisdiction_pack_id = 'pack-ca-v1',
         jurisdiction_pack_version = 1,
         home_currency = 'CAD'
   WHERE jurisdiction_pack_id IS NULL
     AND (
       home_currency IS NULL
       OR btrim(home_currency::text) = ''
       OR upper(btrim(home_currency::text)) = 'CAD'
     );
  GET DIAGNOSTICS assigned = ROW_COUNT;

  UPDATE legal_entities
     SET jurisdiction_pack_id = 'pack-intl-v1',
         jurisdiction_pack_version = 1
   WHERE jurisdiction_pack_id IS NULL;
  GET DIAGNOSTICS baseline = ROW_COUNT;

  /* No legal_entities row means there is no home currency to match.
     Nothing is inserted for them. */
  SELECT count(*) INTO orphans
    FROM (
      SELECT DISTINCT p.legal_entity_id
        FROM ledger_principals p
        LEFT JOIN legal_entities e ON e.id = p.legal_entity_id
       WHERE e.id IS NULL
    ) missing;

  RAISE NOTICE 'pack backfill: % legal_entities assigned the Canada pack, % assigned the international baseline; % ledger principals name an entity with no legal_entities row and were left without a pack', assigned, baseline, orphans;
END $$;
-- pack-backfill:end
