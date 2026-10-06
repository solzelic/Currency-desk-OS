/* ============================================================
   Room on a pack for the rules a country actually writes down.

   A pack already had one identification number and one report number.
   That is not how the rules are written. Canada identifies a foreign
   exchange at one amount and a money transfer at another. India adds
   cash up over a calendar month and uses "more than", not "at least".
   Serbia states some lines in euros and converts them. None of that
   fits in the two numbers migration 011 stored.

   This migration adds the columns and copies today's behaviour into
   them. It does not change a threshold, a pack version, or a posting.
   A later pack is a new row. The rows already here stay the rows a
   posted deal was snapshotted under.

   Draft PR 57 owns migration 027. This is 028 so the two can land in
   either order.
   ============================================================ */

/* ---- identification, one line per kind of deal ----

   NULL means this kind of deal has no identification line.
   0 means every deal of this kind. A positive amount means identify
   at or above that amount.

   The single `jurisdiction_packs.id_threshold` column stays. It is
   still the number the posting gate reads. Each existing pack is
   copied onto every deal kind below, so the gate and this table say
   the same thing until a later pack version splits them.

   `fx` is foreign exchange. `remittance` is a money transfer.
   `eft` is an electronic funds transfer. `virtual_currency` is a
   virtual-currency deal. */
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

INSERT INTO jurisdiction_id_thresholds (pack_id, deal_kind, threshold, currency)
SELECT p.pack_id, k.deal_kind, p.id_threshold, p.home_currency
  FROM jurisdiction_packs p
 CROSS JOIN (
   VALUES ('fx'), ('remittance'), ('eft'), ('virtual_currency')
 ) AS k(deal_kind)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

/* ---- what a report row still could not say ----

   deadline_value + deadline_unit: how long after the deal the report
   is due. calendar_days or business_days. Both null means the pack
   has not stated a deadline. Nothing in the product computed one
   before this migration, so every existing row stays null.

   window_kind: how deals are added together before the threshold is
   tested. fixed_24h is the static 24-hour window the desk already
   uses. calendar_month and none are the other two shapes a pack can
   name. The old aggregation_hours column is left as it was.

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
   This migration does not convert anything. */
ALTER TABLE jurisdiction_reports
  ADD COLUMN IF NOT EXISTS deadline_value integer,
  ADD COLUMN IF NOT EXISTS deadline_unit text,
  ADD COLUMN IF NOT EXISTS window_kind text,
  ADD COLUMN IF NOT EXISTS comparator text,
  ADD COLUMN IF NOT EXISTS direction text,
  ADD COLUMN IF NOT EXISTS threshold_currency char(3);

UPDATE jurisdiction_reports
   SET window_kind = CASE
         WHEN aggregation_hours IS NULL THEN 'none'
         ELSE 'fixed_24h'
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
      OR (
        deadline_value > 0
        AND deadline_unit IN ('calendar_days', 'business_days')
      )
    );

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_window_kind_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_window_kind_check
    CHECK (window_kind IN ('fixed_24h', 'calendar_month', 'none'));

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
