/* ============================================================
   EU AMLR 2027, as its own pack. pack-eu-v1 is not changed.

   Regulation (EU) 2024/1624 applies from 10 July 2027. The row seeded
   in migration 011 called the regulator "AMLD" and stored a 10,000
   report line. There is no European Union large-cash report. That
   row stays as it was published. A new desk in the European Union
   points at pack-eu-v2. A desk already on version 1 stays there
   until the owner opts in.

   Open drafts may already use 029 and 030 (Canada pack, and the
   rate-board / cost-rebase work). 027 belongs to the terms draft.
   031 is the next number that does not collide with those files.
   If one of them lands on 031 first, renumber this file on rebase.
   Do not edit 028 or anything earlier.

   The identification table from migration 028 has one row per kind
   of deal. This pack needs two lines that apply to every kind, so
   those lines live in jurisdiction_rule_lines. The older table and
   its primary key are left alone: a later replay of the migration
   028 copy still matches ON CONFLICT (pack_id, deal_kind).

   aggregation_hours may now be null. Null means this pack does not
   state a window. It is not a 24-hour rule. The check still rejects
   zero and negative counts; a null passes a check, which is what we
   want.
   ============================================================ */

ALTER TABLE jurisdiction_packs
  ALTER COLUMN aggregation_hours DROP NOT NULL;

ALTER TABLE jurisdiction_packs
  ADD COLUMN IF NOT EXISTS applies_from date;

/* One rule line. deal_kind 'any' applies to every kind of deal.
   line_id tells two lines on the same kind apart. */
CREATE TABLE IF NOT EXISTS jurisdiction_rule_lines (
  pack_id text NOT NULL REFERENCES jurisdiction_packs(pack_id),
  line_id text NOT NULL,
  deal_kind text NOT NULL,
  threshold numeric(24,2) NOT NULL,
  currency char(3) NOT NULL,
  comparator text NOT NULL DEFAULT 'gte',
  diligence text NOT NULL DEFAULT 'identify',
  cash_only boolean NOT NULL DEFAULT false,
  PRIMARY KEY (pack_id, line_id, deal_kind),
  CONSTRAINT jurisdiction_rule_lines_kind_check
    CHECK (deal_kind IN ('fx', 'remittance', 'eft', 'virtual_currency', 'any')),
  CONSTRAINT jurisdiction_rule_lines_comparator_check
    CHECK (comparator IN ('gte', 'gt')),
  CONSTRAINT jurisdiction_rule_lines_diligence_check
    CHECK (diligence IN ('identify', 'cdd', 'edd')),
  CONSTRAINT jurisdiction_rule_lines_amount_check
    CHECK (threshold >= 0)
);

/* report_threshold 0 is not a report at zero. The reader treats a
   non-positive pack figure as absent. report_name is empty so a
   screen does not mistake the suspicious-transaction report for a
   large-cash code. id_threshold 3000 is the cash identification
   line the single settings box still edits. */
INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years,
   applies_from)
VALUES
  ('pack-eu-v2', 'EU', 2, 'EU AMLR 2027', 'EUR', 'National FIU',
   '', 0, 3000, 'EUR',
   true, 'country', NULL, 5,
   DATE '2027-07-10')
ON CONFLICT (pack_id) DO NOTHING;

/* Art 19(4): an occasional cash transaction of at least EUR 3,000
   needs at least identification and verification (Art 20(1)(a)).
   Art 19(1)(b): an occasional transaction of at least EUR 10,000,
   single, needs full customer due diligence. Linked transactions
   are real in the regulation, but the test for "linked" is a draft
   regulatory standard that the Commission has not adopted, so this
   pack does not add deals together.
   Art 19(2): a transfer of funds of a value of at least EUR 1,000
   needs customer due diligence. The official text says "at least",
   which is >=, not "more than". */
INSERT INTO jurisdiction_rule_lines
  (pack_id, line_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  ('pack-eu-v2', 'cash_identify', 'any', 3000, 'EUR', 'gte', 'identify', true),
  ('pack-eu-v2', 'occasional_cdd', 'any', 10000, 'EUR', 'gte', 'cdd', false),
  ('pack-eu-v2', 'transfer_cdd', 'remittance', 1000, 'EUR', 'gte', 'cdd', false),
  ('pack-eu-v2', 'transfer_cdd', 'eft', 1000, 'EUR', 'gte', 'cdd', false)
ON CONFLICT (pack_id, line_id, deal_kind) DO NOTHING;

/* Art 69: report a suspicion to the national financial intelligence
   unit, at any amount, including an attempt. The five working days
   are the time allowed to answer a request from that unit. They are
   not a filing deadline, so deadline_value stays null.
   No large_cash row. Article 80's cash payment limit is not encoded
   here: whether it applies to a bureau changing cash for cash is a
   question for counsel, and it is not a hard block. */
INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   filing_format, deadline_value, deadline_unit,
   window_kind, comparator, direction, threshold_currency, cash_only,
   format_rules)
VALUES
  ('rpt-eu-str-v2', 'pack-eu-v2', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL,
   'National FIU', NULL, NULL,
   'none', 'gte', NULL, NULL, false,
   jsonb_build_object(
     'deadline_label',
     'Report a suspicion to your national financial intelligence unit promptly, at any amount, including an attempt. Reply to an information request from that unit within 5 working days. There is no European Union large-cash report.'
   ))
ON CONFLICT (report_id) DO NOTHING;
