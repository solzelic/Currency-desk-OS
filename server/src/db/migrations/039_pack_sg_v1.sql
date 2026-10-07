/* ============================================================
   Singapore, first pack: pack-sg-v1.

   A money-changing service, and a cross-border money transfer
   service, under the Payment Services Act 2019. Home currency SGD.
   MAS supervises the licensee. The Suspicious Transaction Reporting
   Office receives a suspicious transaction report. This file inserts
   that pack. It does not edit a published pack row, and it does not
   move a desk that is already open.

   039 stays. 029, 031, and 033 through 038 are already on main. 027
   and 030 still belong to open drafts. If a later rebase finds 039
   already used, renumber the file name, the id in
   server/src/db/migrations.ts, and this header together. Do not edit
   the file after it has been applied.

   The hour window on jurisdiction_packs cannot say "add the day up".
   MAS Notice PSN01 paragraph 7.4 is the duty. Where the licensee
   suspects two or more transactions are related, linked, or split to
   evade this Notice, they are one transaction and their values are
   added. Guidelines to the Notice, paragraphs 7-2-2 and 7-10-1, say
   when to enquire. They do not replace paragraph 7.4. This desk does
   not add the deals. Storing 24 would tell the till the rule is 24
   hours. NULL means this pack has no hour window. Migrations 033 and
   037 already allow a null hour window, so this file does not change
   the column.

   This file is insert-only. It does not alter a published pack row,
   and it does not move a desk that is already open.
   ============================================================ */

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  /* The single identification column is the money-changing line:
     more than 5000 SGD (PSN01 paragraph 7.3(d), 30 June 2025).
     Exactly 5000 does not. There is no cash transaction report, so
     the report column is 0. The reader treats 0 as "no cash line".
     It must not be read as "require purpose on every deal". A
     cross-border money transfer is not this number. That rule is an
     explicit gate, and the remittance row below is NULL on purpose.
     Paragraph 16.3: keep records five years. The desk does not
     delete them. */
  ('pack-sg-v1', 'SG', 1, 'Singapore', 'SGD', 'MAS / STRO',
   'Suspicious Transaction Report', 0, 5000, 'SGD',
   true, 'country', NULL, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* PSN01 7.3(d) and 7.42: an occasional transaction exceeding
     5000 SGD, except a specified money-changing transaction funded
     from an identifiable source. Cash notes at the counter are not
     that source. Exactly 5000 does not. The till does not see a
     supervised bank account, so it does not grant the exemption. */
  ('pack-sg-v1', 'fx', 5000, 'SGD', 'gt', 'cdd', false),
  /* PSN01 7.3(c) and 7.43: customer due diligence before any
     cross-border money transfer when there are no business relations.
     NULL here is not "no check". The posting gate does not read this
     cell. A stored 0 would also not turn the check off. */
  ('pack-sg-v1', 'remittance', NULL, NULL, 'gte', 'cdd', false),
  /* A domestic electronic transfer, a bill, or a money order is not
     a cross-border money transfer in this product. Paragraph 7.3(d)
     still applies: more than 5000 SGD. A money order must not inherit
     the remittance gate. */
  ('pack-sg-v1', 'eft', 5000, 'SGD', 'gt', 'cdd', false)
  /* No virtual_currency row. A digital payment token is not a
     specified payment service under this Notice. Leaving the row out
     means the till does not invent a 5000 line. A row that is later
     stored as NULL or 0 still fails closed. */
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, filing_format, format_rules)
VALUES
  /* Corruption, Drug Trafficking and Other Serious Crimes
     (Confiscation of Benefits) Act 1992, section 45, and PSN01
     paragraph 18.2: file a suspicious transaction report with the
     STRO as soon as is reasonably practicable, regardless of amount,
     including an attempt. The deadline columns have no unit for that
     phrase, so both stay NULL. The desk does not file and does not
     open SONAR. Copy to MAS is on request. It is not sent from here. */
  ('rpt-sg-str', 'pack-sg-v1', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Listed',
     'note', 'A suspicious transaction report goes to the STRO, as soon as is reasonably practicable, regardless of amount, including an attempt. The desk does not decide suspicion, does not file, and does not open SONAR. CDSA section 45 and PSN01 paragraph 18.2.'
   )),
  /* PSN01 paragraph 15. The payment message must carry originator
     information. At or below 1500 SGD: name and account, or a unique
     reference. Above 1500 SGD: also an address, a national identity
     number, or date and place of birth. This desk does not build that
     message and does not refuse a transfer for a missing field.
     kind is other, not wire, so the screen does not grow a wire report. */
  ('rpt-sg-wire-info', 'pack-sg-v1', 'WIRE-INFO', 'Cross-border wire information', 'other',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Gap',
     'note', 'PSN01 paragraph 15. At or below 1500 SGD the wire message needs the originator name and account or a unique reference. Above 1500 SGD it also needs an address, a national identity number, or date and place of birth. This desk does not build the message and does not refuse a transfer for a missing field.'
   ))
ON CONFLICT (report_id) DO NOTHING;
