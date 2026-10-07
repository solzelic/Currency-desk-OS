/* ============================================================
   India, first pack: pack-in-v1.

   An FFMC or AD Category-II desk. Home currency INR. The Reserve Bank
   of India licenses the shop. FIU-IND receives the reports. This file
   inserts that pack. It does not edit a published v1 pack, and it does
   not move a desk that is already open.

   029, 031, 033, 034, 035, and 036 are already on main, so this file
   stays 037. 027 and 030 still belong to open drafts. If a later
   rebase finds 037 taken, renumber the file name, the id in
   server/src/db/migrations.ts, and this header together. Do not edit
   the file after it has been applied.

   The hour window on jurisdiction_packs cannot say "calendar month".
   Storing 24 would tell the till the rule is 24 hours, which the PML
   Rules do not say. NULL means this pack has no hour window. The month
   lives on the CTR row. Existing packs keep 24.
   ============================================================ */

/* NULL already satisfies a CHECK that compares the column, because a
   comparison with NULL is unknown and a check fails only on false. The
   NOT NULL is what actually rejects it. The check is restated so a
   later pack that also allows NULL does not fight this one. */
ALTER TABLE jurisdiction_packs
  ALTER COLUMN aggregation_hours DROP NOT NULL;

ALTER TABLE jurisdiction_packs
  DROP CONSTRAINT IF EXISTS jurisdiction_packs_aggregation_hours_check;

ALTER TABLE jurisdiction_packs
  ADD CONSTRAINT jurisdiction_packs_aggregation_hours_check
    CHECK (
      aggregation_hours IS NULL
      OR (aggregation_hours > 0 AND aggregation_hours <= 24 * 31)
    );

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  /* PML Rules, rule 3(1)(A): cash of more than ten lakh rupees.
     The single identification column is the walk-in foreign-exchange
     line, fifty thousand rupees. Remittance is every deal, and that
     split lives on jurisdiction_id_thresholds, not in this column.
     Prevention of Money Laundering Act, section 12: keep records five
     years. */
  ('pack-in-v1', 'IN', 1, 'India', 'INR', 'RBI / FIU-IND',
   'Currency Transaction Report', 1000000, 50000, 'INR',
   true, 'country', NULL, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* Reserve Bank of India (Know Your Customer) Directions for NBFCs,
     2025, paragraph 21(5): a walk-in transaction of an amount equal to
     or exceeding Rs. 50,000. Not cash-only. "Appear to be connected"
     is a judgement this table cannot sum, so only the single deal is
     enforced. */
  ('pack-in-v1', 'fx', 50000, 'INR', 'gte', 'cdd', false),
  /* The same directions, paragraph 21(2): any international money
     transfer for a person who does not hold an account. Zero means
     every such deal. */
  ('pack-in-v1', 'remittance', 0, 'INR', 'gte', 'cdd', false),
  ('pack-in-v1', 'eft', 0, 'INR', 'gte', 'cdd', false),
  /* No special virtual-currency line. The occasional-transaction line
     above is the one that exists. The till does not book virtual
     currency. */
  ('pack-in-v1', 'virtual_currency', 50000, 'INR', 'gte', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, filing_format, format_rules)
VALUES
  /* PML Rules, rule 3(1)(A) and (B), and rule 8(1).
     More than ten lakh. Exactly ten lakh is not a report.
     A series is at least two cash deals, each below ten lakh, inside
     one calendar month, whose sum is more than ten lakh. Due by the
     15th of the next month. Filed on FINNET. This desk does not send it. */
  ('rpt-in-ctr', 'pack-in-v1', 'CTR', 'Currency Transaction Report', 'large_cash',
   1000000, 'INR', NULL,
   15, 'monthly_day', 'calendar_month', 'gt', 'both',
   'INR', true, 'FINNET',
   jsonb_build_object(
     'comparator', 'gt',
     'month', 'Asia/Kolkata',
     'note', 'More than 1000000 INR. Exactly 1000000 INR is not a CTR. A series needs at least two cash deals, each below 1000000 INR, in one Asia/Kolkata calendar month, with a sum more than 1000000 INR. Integrally connected is not detected. The same customer in that month is the approximation the desk can make. The desk does not file to FINNET.'
   )),
  /* FIU-IND FAQ: a suspicious transaction report is sent promptly and
     not later than seven working days after the reporting entity is
     satisfied the transaction is suspicious. The count is stored. Indian
     public holidays are not subtracted. The desk does not file it. */
  ('rpt-in-str', 'pack-in-v1', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL,
   7, 'business_days', 'none', 'gte', NULL,
   NULL, false, 'FINNET',
   jsonb_build_object(
     'note', 'Within 7 working days of concluding the transaction is suspicious. The product stores the count and does not subtract Indian holidays. The desk does not file to FINNET.'
   )),
  /* PML Rules, rule 3(1)(E) and rule 8(1). Cross-border wire transfers
     of more than five lakh rupees, origin or destination in India, by
     the 15th of the next month. The till does not file, and it does not
     reliably tell a domestic wire from a cross-border one. A remittance
     is the international product. */
  ('rpt-in-cbwtr', 'pack-in-v1', 'CBWTR', 'Cross Border Wire Transfer Report', 'wire',
   500000, 'INR', NULL,
   15, 'monthly_day', 'calendar_month', 'gt', 'both',
   'INR', false, 'FINNET',
   jsonb_build_object(
     'note', 'Cross-border wires of more than 500000 INR. Due by the 15th of the next month. The till does not separate a domestic wire from a cross-border one. The desk does not file to FINNET.'
   )),
  /* PML Rules, rule 3(1)(C) and rule 8(1). Any cash deal in which forged
     or counterfeit currency notes were used as genuine. No amount. The
     till cannot mark a note counterfeit, so this row is a catalogue
     entry and not a detector. */
  ('rpt-in-ccr', 'pack-in-v1', 'CCR', 'Counterfeit Currency Report', 'other',
   NULL, NULL, NULL,
   15, 'monthly_day', 'none', 'gte', NULL,
   NULL, true, 'FINNET',
   jsonb_build_object(
     'gap', 'The till cannot mark a note as counterfeit, so this report is listed and is not raised from a deal. It would be due by the 15th of the next month. The desk does not file to FINNET.'
   ))
ON CONFLICT (report_id) DO NOTHING;
