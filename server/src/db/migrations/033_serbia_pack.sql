/* ============================================================
   Serbia, pack-rs-v1. The first Serbia pack. Nothing older is edited.

   Migration numbers 027, 029, 030 and 031 are taken by open drafts
   (terms, base currency, Canada v2, EU AMLR). This file is 033 so it
   can land beside them. If a rebase has to renumber it, change the
   filename, the id in server/src/db/migrations.ts, and this header
   together. Do not edit a migration that has already been applied.

   Existing desks are not moved onto this pack. A new desk that picks
   Serbia points at it. A desk already open stays on the pack it has
   until somebody opts it in.

   The amounts below are the euro amounts in the statute. The book is
   kept in dinars. Posting converts a euro line at the newest market
   snapshot (CAD per 1 unit, the same table the rate sync stores) and
   refuses an unidentified customer when that snapshot is missing or
   older than 24 hours. The statute names the National Bank of Serbia
   official middle rate on the day of the transaction. This snapshot
   is not that rate. The gap is recorded on the report row.

   Linked transactions (međusobno povezane) are not a clock window.
   These rows are single-transaction lines. Nothing here adds deals
   together, which is why aggregation_hours is null. The column used
   to refuse null. Null now means "not added together". Every pack
   seeded before this file still stores 24.

   Article 95 keeps records for five years and then they are deleted.
   A competent authority can extend that by up to five more years
   after a proportionality assessment. This pack does not extend
   anything by itself, and it does not delete anything by itself.
   ============================================================ */

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
  /* Article 4(1)(2): an authorised exchange office is an obligor.
     Article 109: the National Bank of Serbia supervises those offices.
     The Administration for the Prevention of Money Laundering (APML)
     is the financial intelligence unit the cash report and the
     suspicion report go to. The single id_threshold is the exchange
     line in Article 8(2), 5,000 euro. The report_threshold is the
     cash report in Article 47(1), 15,000 euro. Both are euros, which
     is why report_currency is EUR and home_currency is RSD. */
  ('pack-rs-v1', 'RS', 1, 'Serbia', 'RSD', 'NBS / APML',
   'Cash transaction report', 15000, 5000, 'EUR',
   true, 'country', NULL, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* Article 8(2): exchange business, 5,000 euro or more, one deal or
     linked deals. Customer due diligence, before the transaction
     (Article 10). Not cash-only: the exchange decision covers cash
     and cheques. */
  ('pack-rs-v1', 'fx', 5000, 'EUR', 'gte', 'cdd', false),
  /* Article 8(1)(3): a transfer of funds higher than 1,000 euro, one
     deal or linked deals, when there is no business relationship.
     "Higher than" is gt, not gte. */
  ('pack-rs-v1', 'remittance', 1000, 'EUR', 'gt', 'cdd', false),
  ('pack-rs-v1', 'eft', 1000, 'EUR', 'gt', 'cdd', false),
  /* Article 8(1)(2): the general occasional line, 15,000 euro or more.
     The 5,000 euro exchange exception does not cover a virtual-currency
     deal. Digital-asset rules stated in dinars are not copied here. */
  ('pack-rs-v1', 'virtual_currency', 15000, 'EUR', 'gte', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind, trigger_threshold, trigger_currency,
   aggregation_hours, filing_format, fields, format_rules, version,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only)
VALUES
  /* Article 47(1): each cash transaction of 15,000 euro or more, in
     dinar countervalue, reported to APML immediately and at latest
     within three days. The deadline column can hold one of those two
     phrases. calendar_days 3 is the latest. "Immediately" is in
     format_rules. Deals are not summed. Direction is both: the article
     says each cash transaction, not only cash the desk received.
     Submission to APML is not sent from this desk. */
  ('rpt-rs-ctr', 'pack-rs-v1', 'CTR', 'Cash transaction report', 'large_cash',
   15000, 'EUR', NULL, 'APML', '[]'::jsonb,
   '{"statute":"Art 47(1)","timing":"Immediately, and at latest within 3 days.","rate":"The statute uses the NBS official middle rate on the transaction day. The desk converts at the market snapshot, which is not that rate.","aggregation":"Each cash transaction. Not a sum.","filing":"The desk does not send this report to APML."}'::jsonb,
   1, 3, 'calendar_days', 'none', 'gte', 'both', 'EUR', true),
  /* Article 47(2): when there are reasons to suspect money laundering
     or terrorist financing, the report goes to APML before the
     transaction is carried out. There is no amount. The till has no
     suspicion flag, and filing the report does not by itself forbid
     the deal once the report has been made. */
  ('rpt-rs-str', 'pack-rs-v1', 'STR', 'Suspicious transaction report', 'suspicious',
   NULL, NULL, NULL, 'APML', '[]'::jsonb,
   '{"statute":"Art 47(2)","timing":"Before the transaction is carried out.","filing":"The till has no suspicion flag and does not send this report. A teller who suspects reports to APML first. The deal may then proceed.","retention":"Article 95: keep five years, then delete. An authority may extend by up to five more years. This pack does not extend and does not delete."}'::jsonb,
   1, NULL, 'before_execution', 'none', 'gte', NULL, NULL, false)
ON CONFLICT (report_id) DO NOTHING;

/* Point 21 of the NBS exchange decision, notice item 4: at an
   international airport or port, airside, behind border control, and
   in a casino gaming space, every buy and every sell of foreign cash
   records the customer's name and JMBG or passport. The flag is off
   unless a desk turns it on. It is a fact about the counter, not
   about the country, so a Canadian branch stays false. */
ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS airside_or_casino boolean NOT NULL DEFAULT false;

/* Receipt facts the exchange post already knows, plus the two the
   NBS decision adds for some deals: the identity number (Point 23
   item 6, and Point 21 notice item 2) and the serial numbers of
   50 and 100 US dollar notes (Point 21 notice item 2). Nullable.
   A deal that does not need them stores null. The ledger row is
   append-only, so these are written on the insert, not after it. */
ALTER TABLE ledger_transactions
  ADD COLUMN IF NOT EXISTS identity_number text,
  ADD COLUMN IF NOT EXISTS note_serials jsonb,
  ADD COLUMN IF NOT EXISTS receipt_facts jsonb;
