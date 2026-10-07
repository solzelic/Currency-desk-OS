/* ============================================================
   Philippines, first pack: pack-ph-v1.

   A money changer, foreign-exchange dealer, or remittance agent.
   Home currency PHP. The Bangko Sentral ng Pilipinas supervises the
   shop. The Anti-Money Laundering Council receives the reports. This
   file inserts that pack. It does not edit a published pack row, and
   it does not move a desk that is already open.

   029, 031, 033, 034, 035, 036, and 037 are already on main, so this
   file stays 038. 027 and 030 still belong to open drafts. If a later
   rebase finds 038 taken, renumber the file name, the id in
   server/src/db/migrations.ts, and this header together. Do not edit
   the file after it has been applied.

   The hour window on jurisdiction_packs cannot say "one banking day".
   Storing 24 would tell the till the rule is 24 hours, which RA 11521
   does not say. NULL means this pack has no hour window. The banking
   day lives on the covered-transaction row. Existing packs keep 24.

   033 and 037 already allow a null hour window. This file does not
   change that column. It only inserts the Philippines rows.
   ============================================================ */

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  /* RA 11521 section 2, amending RA 9160 section 3(b): a covered
     transaction is cash or other equivalent monetary instrument in
     excess of PHP 500,000 within one banking day. The single
     identification column is the money-changing and remittance line,
     more than PHP 5,000 (BSP MORB Part IX, 31 Dec 2023, section
     921(d)(3)). The split with the general PHP 100,000 line lives on
     jurisdiction_id_thresholds. AMLA section 9(b): keep records five
     years. The desk does not delete them. */
  ('pack-ph-v1', 'PH', 1, 'Philippines', 'PHP', 'BSP / AMLC',
   'Covered Transaction Report', 500000, 5000, 'PHP',
   true, 'country', NULL, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* MORB section 921(d)(3): remittance and money changing, any
     transaction exceeding PHP 5,000. Exactly 5,000 does not.
     "Believed to be linked" is not summed. */
  ('pack-ph-v1', 'fx', 5000, 'PHP', 'gt', 'cdd', false),
  ('pack-ph-v1', 'remittance', 5000, 'PHP', 'gt', 'cdd', false),
  /* MORB section 921(d)(1): a transaction exceeding PHP 100,000,
     except money changing or remittance. Bill payment and an
     electronic transfer use this line. Cheque cashing is not money
     changing, so the posting gate reads this same row for it. */
  ('pack-ph-v1', 'eft', 100000, 'PHP', 'gt', 'cdd', false),
  /* No special virtual-currency line. The occasional line above is
     the one that exists. The till does not book virtual currency.
     Leaving the row empty would mean "no line", which is not what
     the section says. */
  ('pack-ph-v1', 'virtual_currency', 100000, 'PHP', 'gt', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, filing_format, format_rules)
VALUES
  /* RA 11521 section 3(b): in excess of PHP 500,000 within one banking
     day, cash or other equivalent monetary instrument. Not cash only.
     Exactly 500,000 is not a covered transaction. AMLC Regulatory
     Issuance No. 1, Series of 2021 (30 Jan 2021), Rule 2 section
     1(w)(1), and MORB section 904(c) (31 Dec 2023) define one
     transaction exceeding PHP 500,000 and do not restate the banking
     day. The stricter reading is the statute. The window is stored.
     The till flags one deal over the line and does not add the day up.
     IRR Rule 22 section 2.1 and MORB section 922: file within five
     working days, unless the AMLC sets a shorter period. Philippine
     holidays are not subtracted. The desk does not file. */
  ('rpt-ph-ctr', 'pack-ph-v1', 'CTR', 'Covered Transaction Report', 'large_cash',
   500000, 'PHP', NULL,
   5, 'business_days', 'banking_day', 'gt', 'both',
   'PHP', false, NULL,
   jsonb_build_object(
     'comparator', 'gt',
     'note', 'A single deal over 500000 PHP is flagged. Exactly 500000 PHP is not a covered transaction. Deals in one banking day are not added together. The desk must check them. The desk does not file to the AMLC. The stored deadline is 5 working days. Philippine holidays are not subtracted. The AMLC form is not prepared.'
   )),
  /* AMLC amendment of the 2018 IRR, effective 1 Feb 2020: a suspicious
     transaction is filed within the next working day from the date
     suspicion is established. MORB section 922 (31 Dec 2023) still
     says five working days for both reports. This row stores the AMLC
     clock. The desk does not decide suspicion and does not file. */
  ('rpt-ph-str', 'pack-ph-v1', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL,
   1, 'business_days', 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'note', 'Next working day from the date suspicion is established. The product stores the count and does not subtract Philippine holidays. The desk does not decide suspicion and does not file to the AMLC. MORB section 922 still says five working days. This row follows the AMLC clock.'
   ))
ON CONFLICT (report_id) DO NOTHING;
