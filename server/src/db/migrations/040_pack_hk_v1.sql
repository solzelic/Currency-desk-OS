/* ============================================================
   Hong Kong, first pack: pack-hk-v1.

   A money service operator under the Anti-Money Laundering and
   Counter-Terrorist Financing Ordinance (Cap. 615). Home currency
   HKD. The Customs and Excise Department licenses the operator.
   The Joint Financial Intelligence Unit receives a suspicious
   transaction report. This file inserts that pack. It does not
   edit a published pack row, and it does not move a desk that is
   already open.

   Open drafts own 027 and 029 through 039. This is 040 so it can
   land beside them. If a rebase finds 040 already used, renumber
   the file name, the id in server/src/db/migrations.ts, and this
   header together. Do not edit the file after it has been applied.

   The hour window on jurisdiction_packs cannot say "add the day
   up". Schedule 2 talks about operations that appear to be linked.
   This desk does not add them. Storing 24 would tell the till the
   rule is 24 hours. NULL means this pack has no hour window.
   Existing packs keep 24.

   The two ALTER statements change the column constraint so NULL is
   a legal value. They do not update any pack row.
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
  /* The single identification column is the money-changing line:
     at or above 120000 HKD (Schedule 2 section 3(1)(b)). Exactly
     120000 does. There is no cash transaction report, so the report
     column is 0. The reader treats 0 as "no cash line". It must not
     be read as "require purpose on every deal". A wire, a remittance,
     and a virtual asset transfer are not this number. Those lines are
     the rows below. Section 20: keep records at least five years. The
     desk does not delete them. */
  ('pack-hk-v1', 'HK', 1, 'Hong Kong', 'HKD', 'C&ED / JFIU',
   'Suspicious Transaction Report', 0, 120000, 'HKD',
   true, 'country', NULL, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* Schedule 2 section 3(1)(b): an occasional transaction equal to
     or above 120000 HKD, whether one operation or several that appear
     to be linked. Money changing is this line. A bill, a money order,
     and a cheque are other occasional transactions, and the table has
     no separate kind for them, so the posting gate reads this row for
     those three as well. Section 3(1B) is a licensed VAS provider
     rule and is not applied here. */
  ('pack-hk-v1', 'fx', 120000, 'HKD', 'gte', 'cdd', false),
  /* Schedule 2 section 3(1A)(a) is customer due diligence on a wire
     transfer equal to or above 8000 HKD. Section 3(1)(c) is not this
     line. It was repealed by 15 of 2022 section 33. Section 13 is
     originator identification on a non-wire remittance equal to or
     above 8000 HKD.
     The product has one remittance kind and one verified state, so
     this row is 8000, at or above. A stored 0 or NULL must not turn
     the check off. Exactly 8000 blocks. 7999.99 does not. */
  ('pack-hk-v1', 'remittance', 8000, 'HKD', 'gte', 'cdd', false),
  /* A domestic or cross-border electronic transfer is a wire under
     section 1(4) and section 3(1A)(a): at or above 8000 HKD. */
  ('pack-hk-v1', 'eft', 8000, 'HKD', 'gte', 'cdd', false),
  /* Schedule 2 section 3(1A)(b): a virtual asset transfer of virtual
     assets amounting to no less than 8000 HKD. A missing row is not
     "no line". The statute has a line, so the gate blocks if the row
     is gone, blank, or zero. */
  ('pack-hk-v1', 'virtual_currency', 8000, 'HKD', 'gte', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, filing_format, format_rules)
VALUES
  /* OSCO Cap. 455 section 25A and DTROP Cap. 405 section 25A: disclose
     to an authorised officer as soon as it is reasonable to do so.
     UNATMO Cap. 575 section 12: as soon as is practicable. The JFIU
     receives the report. No numeric deadline unit fits that phrase,
     so both deadline columns stay NULL. The desk does not file and
     does not open STREAMS. */
  ('rpt-hk-str', 'pack-hk-v1', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Listed',
     'note', 'A suspicious transaction report goes to the JFIU. OSCO section 25A and DTROP section 25A say as soon as it is reasonable to do so. UNATMO section 12 says as soon as is practicable. Any amount, including an attempt. The desk does not decide suspicion, does not file, and does not open STREAMS.'
   )),
  /* Schedule 2 section 12. Any wire needs originator name and account
     or unique reference, plus recipient name and account or reference.
     At or above 8000 HKD it also needs address, identification number,
     or date and place of birth. This desk does not build that message
     and does not refuse a transfer for a missing field. kind is other,
     not wire, so the screen does not grow a wire report. */
  ('rpt-hk-wire-info', 'pack-hk-v1', 'WIRE-INFO', 'Wire transfer information', 'other',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Gap',
     'note', 'AMLO Schedule 2 section 12. A wire transfer of any amount needs the originator name and account or unique reference, and the recipient name and account or unique reference. At or above 8000 HKD it also needs an address, an identification number, or date and place of birth. This desk does not build the message and does not refuse a transfer for a missing field.'
   )),
  /* Schedule 2 section 13. The amount gate is the remittance row.
     These extra record fields are not collected. */
  ('rpt-hk-remit-record', 'pack-hk-v1', 'REMIT-RECORD', 'Remittance record fields', 'other',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Gap',
     'note', 'AMLO Schedule 2 section 13. A remittance that is not a wire transfer, at or above 8000 HKD, also needs the identification document number, the place of issue if it is a travel document, the recipient address, the method of delivery, and the date and time of the instructions. This desk does not collect those fields. The amount gate is enforced separately.'
   )),
  /* Schedule 2 section 13A. Customer due diligence itself is the
     virtual currency row. The message is not built here. */
  ('rpt-hk-va-info', 'pack-hk-v1', 'VA-INFO', 'Virtual asset transfer information', 'other',
   NULL, NULL, NULL,
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, NULL,
   jsonb_build_object(
     'status', 'Gap',
     'note', 'AMLO Schedule 2 section 13A. A virtual asset transfer needs originator and recipient information. At or above 8000 HKD it also needs the extra originator details. This desk does not build that message.'
   ))
ON CONFLICT (report_id) DO NOTHING;
