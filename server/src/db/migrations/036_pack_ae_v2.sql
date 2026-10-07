/* ============================================================
   United Arab Emirates, version 2. An exchange house under the
   CBUAE Exchange Business Standards (Chapter 16) and Cabinet
   Resolution No. 134 of 2025.

   pack-ae-v1 is not edited. A desk already on it stays there until
   an administrator opts in. A deal already posted keeps the pack
   id stamped on it. This file inserts rows and nothing else.

   029, 031, 033, 034, and 035 are already on main, so this file
   stays 036. 027 and 030 still belong to open drafts. If a later
   rebase finds 036 taken, renumber this file and the entry in
   server/src/db/migrations.ts together. Do not edit a migration
   that has already been applied.

   What an exchange house actually has to do on one deal:

     Standards 16.7 / 16.8   foreign exchange of AED 3,500 or more:
                             customer identification. "Or more" is gte.
                             AED 3,499.99 does not trigger.
     Standards 16.9          one foreign exchange of AED 35,000 or
                             more: customer due diligence (purpose
                             and source of funds). The same article
                             also adds deals across 90 days. This
                             table has one identification row per
                             kind, so the 90 day sum is not stored.
                             The posting gate applies the one-deal
                             half. See docs/UAE_PACK.md.
     Standards 16.7 / 16.9   a money transfer of any amount: customer
                             identification and customer due diligence.
                             Threshold 0 means every deal.
     Standards 16.10         enhanced due diligence at AED 55,000,
                             including a 90 day sum for foreign
                             exchange and a 45 day sum for transfers.
                             There is no field for the extra evidence,
                             and no second band. Not encoded.
     Standards 16.25         confirmed sanctions match: Fund Freeze
                             Report via goAML within 2 business days.
                             Potential match: Partial Name Match
                             Report (PMNR). Catalogue only.
     Standards 16.27         STR or SAR via goAML, any amount,
                             including an attempt, without delay.
     Cabinet Resolution 134
       of 2025, Article 25   keep the records for at least 5 years.

   There is no cash threshold report for an exchange house at
   AED 55,000. That figure is the occasional-transaction customer
   due diligence line in Article 7 of Cabinet Resolution 134 of
   2025, and the cash report line for dealers in precious metals
   and stones in Article 3. It is not this pack. report_threshold
   is 0, which the reader treats as "no amount", not as "report
   every deal".

   aggregation_hours stays 24 because the column cannot be empty
   and cannot hold 90 days (the check stops at 31 days). The report
   rows say window_kind none, and that is the rule. 24 is not the
   90 day band.

   The single id_threshold column is the foreign-exchange
   identification line, AED 3,500. It is what the Settings box
   compares against. The transfer line lives on
   jurisdiction_id_thresholds. The posting gate for this pack
   reads those rows.

   A virtual-currency row has no amount. Chapter 16 does not state
   one for this business, and the till does not book that product.
   A missing amount fails closed.

   Cheque cashing is not a row of its own. The gate already maps
   it to foreign exchange, so identification is AED 3,500. This
   file does not add a purpose rule for a cheque.
   ============================================================ */

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  ('pack-ae-v2', 'AE', 2, 'United Arab Emirates', 'AED', 'CBUAE',
   'STR', 0, 3500, 'AED',
   true, 'country', 24, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* Standards 16.8: one foreign exchange from AED 3,500 up to the
     next band. The next band is not a second row. */
  ('pack-ae-v2', 'fx', 3500, 'AED', 'gte', 'identify', false),
  /* Standards 16.7 and 16.9: a money transfer of any amount.
     0 means every deal, and diligence cdd means purpose and source
     of funds as well as identification. */
  ('pack-ae-v2', 'remittance', 0, 'AED', 'gte', 'cdd', false),
  ('pack-ae-v2', 'eft', 0, 'AED', 'gte', 'cdd', false),
  /* No Chapter 16 line for virtual currency on an exchange house.
     NULL fails closed. The till does not book this product. */
  ('pack-ae-v2', 'virtual_currency', NULL, NULL, 'gte', 'identify', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours, filing_format,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, format_rules)
VALUES
  /* Standards 16.27 and Cabinet Resolution 134 of 2025, Article 18.
     No amount. Not a large-cash report. */
  ('rpt-ae-str-v2', 'pack-ae-v2', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL, 'goAML',
   NULL, 'immediately', 'none', 'gte', NULL,
   NULL, false,
   jsonb_build_object(
     'deadline_label', 'immediately and without delay',
     'recipient', 'UAE Financial Intelligence Unit',
     'channel', 'goAML',
     'note', 'A suspicious transaction report, including an attempt, at any amount. There is no cash threshold report for an exchange house. This till does not file it.'
   )),
  ('rpt-ae-sar-v2', 'pack-ae-v2', 'SAR', 'Suspicious Activity Report', 'suspicious',
   NULL, NULL, NULL, 'goAML',
   NULL, 'immediately', 'none', 'gte', NULL,
   NULL, false,
   jsonb_build_object(
     'deadline_label', 'immediately and without delay',
     'recipient', 'UAE Financial Intelligence Unit',
     'channel', 'goAML',
     'note', 'Suspicious activity with no transaction. Same channel as an STR. This till does not file it.'
   )),
  /* Standards 16.25. Confirmed match. 2 business days, via goAML. */
  ('rpt-ae-ffr-v2', 'pack-ae-v2', 'FFR', 'Fund Freeze Report', 'other',
   NULL, NULL, NULL, 'goAML',
   2, 'business_days', 'none', 'gte', NULL,
   NULL, false,
   jsonb_build_object(
     'deadline_label', 'within 2 business days of a confirmed match',
     'recipient', 'UAE Financial Intelligence Unit',
     'channel', 'goAML',
     'note', 'A confirmed sanctions match. Freeze without delay means within 24 hours of the listing. This till does not file the report and does not run the freeze.'
   )),
  /* Standards 16.25. Potential match. No counted deadline: the desk
     suspends until goAML answers. PMNR is the name in the Standards.
     PNMR is the same report under another spelling. */
  ('rpt-ae-pmnr-v2', 'pack-ae-v2', 'PMNR', 'Partial Name Match Report', 'other',
   NULL, NULL, NULL, 'goAML',
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false,
   jsonb_build_object(
     'deadline_label', 'suspend until goAML sends instructions',
     'recipient', 'UAE Financial Intelligence Unit',
     'channel', 'goAML',
     'also_called', 'PNMR',
     'note', 'A potential sanctions name match. Partial Name Match Report (PMNR). This till does not file it.'
   ))
ON CONFLICT (report_id) DO NOTHING;
