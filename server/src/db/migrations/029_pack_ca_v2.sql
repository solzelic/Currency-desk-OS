/* ============================================================
   Canada pack version 2.

   pack-ca-v1 stays exactly as it was seeded. This file does not
   UPDATE that row, its reports, its identification lines, or any
   legal entity. A desk already on version 1 keeps it until an owner
   opts in (see server/src/ledger/threshold-control.ts). A new Canada
   desk is pointed at pack-ca-v2 by the country map, not by this file.

   The numbers below are the ones in the Proceeds of Crime (Money
   Laundering) and Terrorist Financing Regulations, SOR/2002-184,
   current to 2026-09-21 (last amended 2026-03-26), read 2026-10-06
   at https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/.
   Citations in the comments are that text. They are not a paraphrase
   of the website.
   ============================================================ */

/* Money orders are their own identification line. Section 95(1)(a)
   is $3,000. Mapping them onto the remittance line would pull them
   down to $1,000, which the regulation does not say. */
ALTER TABLE jurisdiction_id_thresholds
  DROP CONSTRAINT IF EXISTS jurisdiction_id_thresholds_kind_check;
ALTER TABLE jurisdiction_id_thresholds
  ADD CONSTRAINT jurisdiction_id_thresholds_kind_check
    CHECK (deal_kind IN (
      'fx', 'remittance', 'eft', 'virtual_currency', 'money_order'
    ));

/* A large virtual currency report is not a large cash report. Giving
   it its own kind keeps the cash engine from filing it as an LCTR. */
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'jurisdiction_reports'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%large_cash%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jurisdiction_reports DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_kind_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_kind_check
    CHECK (kind IN (
      'large_cash', 'wire', 'suspicious', 'other', 'virtual_currency'
    ));

/* LCTR and LVCTR add every amount in the window, including one that
   is already over $10,000. EFTR does not: FINTRAC still uses the
   older rule for that form. NULL axes means the report does not name
   them. */
ALTER TABLE jurisdiction_reports
  ADD COLUMN IF NOT EXISTS aggregate_all_amounts boolean NOT NULL DEFAULT false;

ALTER TABLE jurisdiction_reports
  ADD COLUMN IF NOT EXISTS aggregation_axes text[];

ALTER TABLE jurisdiction_reports
  DROP CONSTRAINT IF EXISTS jurisdiction_reports_axes_check;
ALTER TABLE jurisdiction_reports
  ADD CONSTRAINT jurisdiction_reports_axes_check
    CHECK (
      aggregation_axes IS NULL
      OR (
        cardinality(aggregation_axes) > 0
        AND aggregation_axes <@ ARRAY['conductor', 'on_behalf_of', 'beneficiary']::text[]
      )
    );

/* The person a remittance is for, and where they are. Section 36
   (c.1) to (f) asks for both on the record. Nullable so a deal that
   is not a remittance, and every row already posted, stays valid. */
ALTER TABLE ledger_obligations
  ADD COLUMN IF NOT EXISTS beneficiary_name text,
  ADD COLUMN IF NOT EXISTS beneficiary_address text;

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  /* id_threshold stays the foreign-exchange line. That is the one
     number the settings screen still edits. The other lines live in
     jurisdiction_id_thresholds and are what the gate reads, because
     they are not all 3,000. */
  ('pack-ca-v2', 'CA', 2, 'Canada', 'CAD', 'FINTRAC',
   'LCTR', 10000, 3000, 'CAD',
   true, 'country', 24, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* s.95(1)(c): foreign exchange, $3,000 or more. Not cash-only. */
  ('pack-ca-v2', 'fx', 3000, 'CAD', 'gte', 'identify', false),
  /* s.95(1)(a.1) and (e.1): transmitting funds, or being the
     beneficiary of funds, other than an EFT, $1,000 or more. */
  ('pack-ca-v2', 'remittance', 1000, 'CAD', 'gte', 'identify', false),
  /* s.95(1)(b) and (f): initiating an EFT, or being the beneficiary
     of an international EFT, $1,000 or more. */
  ('pack-ca-v2', 'eft', 1000, 'CAD', 'gte', 'identify', false),
  /* s.95(1)(d) and (e): a virtual-currency transfer or exchange,
     $1,000 or more. The till does not book one yet. The line is here
     so the pack matches the regulation when it can. */
  ('pack-ca-v2', 'virtual_currency', 1000, 'CAD', 'gte', 'identify', false),
  /* s.95(1)(a): money orders, $3,000 or more. Not the remittance line. */
  ('pack-ca-v2', 'money_order', 3000, 'CAD', 'gte', 'identify', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours, filing_format,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, aggregate_all_amounts, aggregation_axes,
   format_rules)
VALUES
  /* s.30 and s.126: cash received of $10,000 or more. s.132(3): file
     within 15 days after the day of receipt. s.126 plus the FINTRAC
     24-hour guidance (updated 2023-10-23): every amount in the static
     window, on three axes that are not mixed. */
  ('rpt-ca-lctr-v2', 'pack-ca-v2', 'LCTR', 'Large Cash Transaction Report', 'large_cash',
   10000, 'CAD', 24, 'FWR JSON batch',
   15, 'calendar_days', 'fixed_24h', 'gte', 'in',
   'CAD', true, true, ARRAY['conductor', 'on_behalf_of', 'beneficiary']::text[],
   '{}'::jsonb),
  /* s.132(1): an EFTR within 5 working days. The 24-hour guidance
     still tells an EFTR to leave out a single transfer already at
     $10,000 and file that one on its own, until the new form exists.
     aggregate_all_amounts stays false for that reason. Axes stay
     unset so the screen does not invent the new rule. */
  ('rpt-ca-eftr-v2', 'pack-ca-v2', 'EFTR', 'Electronic Funds Transfer Report', 'wire',
   10000, 'CAD', 24, 'FWR JSON batch',
   5, 'business_days', 'fixed_24h', 'gte', 'both',
   'CAD', false, false, NULL,
   '{}'::jsonb),
  /* s.30(1)(f), s.32, s.129, s.132(2): virtual currency received of
     $10,000 or more, within 5 working days, same 24-hour rule as an
     LCTR. There is no virtual-currency till yet. The row is the
     obligation, not a claim that the counter takes crypto. */
  ('rpt-ca-lvctr-v2', 'pack-ca-v2', 'LVCTR', 'Large Virtual Currency Transaction Report', 'virtual_currency',
   10000, 'CAD', 24, 'FWR JSON batch',
   5, 'business_days', 'fixed_24h', 'gte', 'in',
   'CAD', false, true, ARRAY['conductor', 'on_behalf_of', 'beneficiary']::text[],
   '{}'::jsonb),
  /* Suspicious Transaction Report. No amount. The regulations say
     "as soon as practicable", which is not one of the deadline units,
     so the words live on the row instead of being forced into
     "immediately". */
  ('rpt-ca-str-v2', 'pack-ca-v2', 'STR', 'Suspicious Transaction Report', 'suspicious',
   NULL, NULL, NULL, 'FWR JSON batch',
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false, false, NULL,
   '{"deadline_label":"as soon as practicable"}'::jsonb),
  /* Listed Person or Entity Property Report. FINTRAC's name, from
     2025, for what used to be called a terrorist property report.
     Act s.7.1 and the Proceeds of Crime (Money Laundering) and
     Terrorist Financing Suspicious Transaction Reporting Regulations.
     File immediately. This is property of a listed person or a
     terrorist group. It is not a country-of-residence sanctions stop,
     and it is not the baseline SANCTIONS-STOP code. */
  ('rpt-ca-lpepr-v2', 'pack-ca-v2', 'LPEPR', 'Listed Person or Entity Property Report', 'other',
   NULL, NULL, NULL, 'FWR JSON batch',
   NULL, 'immediately', 'none', 'gte', NULL,
   NULL, false, false, NULL,
   '{}'::jsonb)
ON CONFLICT (report_id) DO NOTHING;
