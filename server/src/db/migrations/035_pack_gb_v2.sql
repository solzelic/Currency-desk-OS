/* ============================================================
   United Kingdom, version 2. A bureau de change / money service
   business under the Money Laundering Regulations 2017 and the
   Proceeds of Crime Act 2002. Not a high-value dealer, not a
   casino, and not a cryptoasset exchange provider.

   pack-gb-v1 is not edited. A desk already on it stays there until
   an administrator opts in. A deal already posted keeps the pack
   id stamped on it. This file inserts rows and nothing else.

   029, 031, 033, and 034 are already on main. 027 and 030 still
   belong to open drafts. This file is 035. Do not edit a migration
   that has already been applied.

   What the law requires of an occasional deal, sterling figures in
   force from 30 June 2026 (SI 2026/621):

     reg 27(2)   a transaction of £12,000 or more: customer due
                 diligence. "Or more" is gte.
     reg 27(1)(b) an occasional transfer of funds exceeding £800:
                 customer due diligence. "Exceeding" is gt. £800.00
                 does not trigger. £800.01 does.
     reg 40      keep the records for five years.
     POCA s.330  a suspicious activity report to a nominated officer
                 or the NCA, as soon as is practicable. No amount.

   There is no large-cash report and no currency transaction report.
   The 10,000 figure on pack-gb-v1 is the high-value-dealer cash
   line in reg 27(3). It is not this pack. report_threshold is 0,
   which the reader treats as "no amount", not as "report every deal".

   reg 27(7E), a cryptoasset transfer of £800 or more, applies to a
   cryptoasset exchange provider or a custodian wallet provider.
   A bureau is not one of those. A virtual-currency deal on this
   pack follows the occasional-transaction line, £12,000 or more.

   reg 27(2) also covers several operations which appear to be
   linked. That is a judgment. This pack does not add deals
   together. aggregation_hours stays 24 because the column cannot
   be empty. The SAR row says window_kind none, and that is the rule.

   The single id_threshold column is the occasional-transaction
   line, £12,000. It is what the Settings box compares against.
   The transfer line lives on jurisdiction_id_thresholds. The
   posting gate for this pack reads those rows.
   ============================================================ */

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  ('pack-gb-v2', 'GB', 2, 'United Kingdom', 'GBP', 'HMRC',
   'SAR', 0, 12000, 'GBP',
   true, 'country', 24, 5)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* reg 27(2): an occasional transaction of £12,000 or more. */
  ('pack-gb-v2', 'fx', 12000, 'GBP', 'gte', 'cdd', false),
  /* reg 27(1)(b): an occasional transfer of funds exceeding £800. */
  ('pack-gb-v2', 'remittance', 800, 'GBP', 'gt', 'cdd', false),
  ('pack-gb-v2', 'eft', 800, 'GBP', 'gt', 'cdd', false),
  /* A bureau is not a cryptoasset firm. reg 27(7E) is not this line.
     The occasional-transaction line applies instead. */
  ('pack-gb-v2', 'virtual_currency', 12000, 'GBP', 'gte', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours, filing_format,
   deadline_value, deadline_unit, window_kind, comparator, direction,
   threshold_currency, cash_only, format_rules)
VALUES
  /* POCA 2002 s.330. No amount. Not a large-cash report.
     The deadline is words, not one of the counted units, so the
     columns stay null and the label carries the statute. */
  ('rpt-gb-sar-v2', 'pack-gb-v2', 'SAR', 'Suspicious Activity Report', 'suspicious',
   NULL, NULL, NULL, 'NCA SAR Online',
   NULL, NULL, 'none', 'gte', NULL,
   NULL, false,
   jsonb_build_object(
     'deadline_label', 'as soon as is practicable',
     'recipient', 'NCA UKFIU',
     'supervisor', 'HMRC',
     'note', 'There is no UK large-cash report for a bureau. A SAR is raised by a person, not by an amount, and is made to the NCA (UKFIU). A defence against money laundering under the Proceeds of Crime Act is a separate request. This till does not send either.'
   ))
ON CONFLICT (report_id) DO NOTHING;
