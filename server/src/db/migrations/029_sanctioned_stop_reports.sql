/* ============================================================
   The report a sanctions stop names.

   pack-intl-v1 already has SANCTIONS-STOP (migration 028). This
   flags that row so the posting path can find it without matching
   on the code. The Canada pack had LCTR, EFTR, and STR only. It
   gains a Terrorist Property Report, code TPR, which is the
   Canada equivalent of that stop.

   The filing format is left empty. An empty field list is "not
   transcribed yet". A guessed FINTRAC form would look official
   and be wrong. The flag the stop path reads is
   format_rules.sanctionsStop.

   Draft PR 57 owns migration 027. 028 is the pack rule fields.
   This is 029.
   ============================================================ */

UPDATE jurisdiction_reports
   SET format_rules = coalesce(format_rules, '{}'::jsonb) || '{"sanctionsStop": true}'::jsonb
 WHERE report_id = 'intl-sanctions-v1';

DO $$
DECLARE
  flagged integer;
BEGIN
  SELECT count(*) INTO flagged
    FROM jurisdiction_reports
   WHERE report_id = 'intl-sanctions-v1'
     AND coalesce(format_rules, '{}'::jsonb) @> '{"sanctionsStop": true}'::jsonb;
  IF flagged <> 1 THEN
    RAISE EXCEPTION 'intl-sanctions-v1 was not flagged as the sanctions stop report';
  END IF;
END $$;

INSERT INTO jurisdiction_reports (
  report_id, pack_id, code, name, kind,
  trigger_threshold, trigger_currency, aggregation_hours, filing_format,
  deadline_unit, window_kind, comparator, direction, cash_only,
  format_rules
) VALUES (
  'rpt-ca-tpr', 'pack-ca-v1', 'TPR', 'Terrorist Property Report', 'other',
  NULL, NULL, NULL, NULL,
  'immediately', 'none', 'gte', NULL, false,
  '{"sanctionsStop": true}'::jsonb
) ON CONFLICT (report_id) DO NOTHING;
