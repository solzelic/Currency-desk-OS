/* ============================================================
   Australia, second edition: pack-au-v2.

   pack-au-v1 is published. This file does not update it, and it does
   not move a desk that already points at it. A new Australian desk is
   sent here by the signup map. An existing desk moves only when its
   owner opts in, and that opt-in does not rewrite a posted deal.

   029, 031, and 033 are already on main. 027 and 030 are still open
   drafts, so this file stays 034. Do not edit a migration that has
   already been applied.

   The numbers below are the Anti-Money Laundering and Counter-Terrorism
   Financing Act 2006 (Cth), compilation in force 1 July 2026, read with
   the AML/CTF Rules and the Exemptions Rules. Citations are in
   docs/AUSTRALIA_PACK.md.

   Identification (Act s.28, table 1 item 50, s.39E items 9 and 10).
   Exchanging currency in a currency-exchange business is a designated
   service with no amount in the item itself. Section 28 says the
   reporting entity must not start the service until initial customer
   due diligence is done. Section 39E items 9 and 10 say section 28
   does not apply to item 50 when the value is less than 1,000 dollars,
   in the cash-bureau case and in the case where the currency is moved
   into an ADI account. The foreign-exchange line is therefore 1000 AUD,
   at or above, customer due diligence. It is not zero. Zero would
   require due diligence on a 20 dollar cash exchange that section 39E
   says section 28 does not apply to.

   A remittance or electronic transfer (table 1 items 29 and 30) has no
   such amount exemption, so those lines are zero: every deal. A money
   order is designated only when its face value is not less than 1,000
   (items 27 and 28). That exception is applied in code. It is not a
   fifth deal_kind, because the check on this table only allows four.
   Virtual-asset exchange (items 50A and 50B) is also every deal. The
   till does not book virtual assets yet. The line is here so the pack
   is not silent about them.

   The hotel exemption in the Exemptions Rules, chapter 31, is not a
   bureau. It is not encoded.

   Threshold transaction report (Act s.43, definition in s.5). Physical
   currency of 10,000 dollars or more received or paid, in one
   transaction. Due 10 business days after the day of the transaction.
   Deals are not added together. The pack's aggregation_hours column
   cannot be null or zero (migration 016), so it stays 24. That column
   is not the rule. The report row's window_kind 'none' is the rule.

   Suspicious matter report (Act s.41). Terrorism financing: 24 hours
   after the time the suspicion is formed. Anything else: 3 business
   days after the day the suspicion is formed. Two codes, because one
   code can hold only one deadline (the read keeps the highest version
   of each code). The 5 business day legal-professional-privilege case
   in s.41(2)(aa) is named in the format notes, not as a third detector.

   International value transfer service (Act ss.45 and 46). This is the
   report that used to be called an IFTI. No amount. In or out. Due 10
   business days after the transfer message is passed on or received.
   Section 46 itself is deferred until the entity's transition date
   (31 March 2029, or a later date no later than 30 September 2029
   where the entity had filed an IFTI before 31 March 2026). Until
   then the old IFTI obligation continues. This pack uses the current
   name and does not also seed an IFTI row.

   Annual compliance report (Act s.47, AML/CTF Rules 9-9). Real, and
   not something the till prepares. The deadline units cannot say
   "3 months after 30 June", so the deadline is left unset and the
   words are in the format notes.

   Records (Act s.107). Seven years, which pack-au-v1 already stored.
   ============================================================ */

INSERT INTO jurisdiction_packs
  (pack_id, jurisdiction, version, name, home_currency, regulator,
   report_name, report_threshold, id_threshold, report_currency,
   allow_cross_currency, kind, aggregation_hours, retention_years)
VALUES
  ('pack-au-v2', 'AU', 2, 'Australia', 'AUD', 'AUSTRAC',
   'TTR', 10000, 1000, 'AUD',
   true, 'country', 24, 7)
ON CONFLICT (pack_id) DO NOTHING;

INSERT INTO jurisdiction_id_thresholds
  (pack_id, deal_kind, threshold, currency, comparator, diligence, cash_only)
VALUES
  /* Act s.39E items 9 and 10: initial CDD from 1,000 AUD. */
  ('pack-au-v2', 'fx', 1000, 'AUD', 'gte', 'cdd', false),
  /* Table 1 items 29 and 30. No amount exemption. */
  ('pack-au-v2', 'remittance', 0, 'AUD', 'gte', 'cdd', false),
  ('pack-au-v2', 'eft', 0, 'AUD', 'gte', 'cdd', false),
  /* Table 1 items 50A and 50B. The till does not book these yet. */
  ('pack-au-v2', 'virtual_currency', 0, 'AUD', 'gte', 'cdd', false)
ON CONFLICT (pack_id, deal_kind) DO NOTHING;

INSERT INTO jurisdiction_reports
  (report_id, pack_id, code, name, kind,
   trigger_threshold, trigger_currency, aggregation_hours,
   filing_format, format_rules, version,
   deadline_value, deadline_unit, window_kind, comparator,
   direction, threshold_currency, cash_only)
VALUES
  ('rpt-au-ttr-v2', 'pack-au-v2', 'TTR', 'Threshold Transaction Report', 'large_cash',
   10000, 'AUD', NULL,
   'AUSTRAC Online',
   '{"statute":"AML/CTF Act s.43","note":"Physical currency of 10000 AUD or more received or paid, in one transaction. Deals are not added together. Due 10 business days after the day of the transaction. Foreign currency is translated to AUD under s.18. The till does not file this report to AUSTRAC."}'::jsonb,
   1,
   10, 'business_days', 'none', 'gte',
   'both', 'AUD', true),

  ('rpt-au-smr-v2', 'pack-au-v2', 'SMR', 'Suspicious Matter Report', 'suspicious',
   NULL, NULL, NULL,
   'AUSTRAC Online',
   '{"statute":"AML/CTF Act s.41(2)","note":"Suspicion other than terrorism financing. Due 3 business days after the day the suspicion is formed. A partial legal professional privilege claim that belongs to someone else is 5 business days under s.41(2)(aa). That case is not a separate row. The till does not file this report to AUSTRAC."}'::jsonb,
   1,
   3, 'business_days', 'none', 'gte',
   NULL, NULL, false),

  ('rpt-au-smr-tf-v2', 'pack-au-v2', 'SMR-TF', 'Suspicious Matter Report, terrorism financing', 'suspicious',
   NULL, NULL, NULL,
   'AUSTRAC Online',
   '{"statute":"AML/CTF Act s.41(2)","note":"Suspicion of financing of terrorism. Due 24 hours after the time the suspicion is formed. The till does not decide that suspicion and does not file the report."}'::jsonb,
   1,
   24, 'hours', 'none', 'gte',
   NULL, NULL, false),

  ('rpt-au-ivts-v2', 'pack-au-v2', 'IVTS', 'International Value Transfer Service report', 'wire',
   NULL, NULL, NULL,
   'AUSTRAC Online',
   '{"statute":"AML/CTF Act ss.45 and 46","note":"Formerly called an IFTI. No amount. In or out. Due 10 business days after the transfer message is passed on or received. Section 46 reporting is deferred until the entity IVTS transition date: 31 March 2029, or a substitute date no earlier than that and no later than 30 September 2029 where the entity filed at least one IFTI before 31 March 2026. Until that date the pre-31 March 2026 IFTI obligation continues. This row uses the current name and does not also list an IFTI. The till does not submit the report. A transfer that the entity determines will not occur, and takes reasonable steps to stop, is not reported (s.46(3)). That stop is not detected here."}'::jsonb,
   1,
   10, 'business_days', 'none', 'gte',
   'both', NULL, false),

  ('rpt-au-compliance-v2', 'pack-au-v2', 'COMPLIANCE', 'Annual compliance report', 'other',
   NULL, NULL, NULL,
   'AUSTRAC Online',
   '{"statute":"AML/CTF Act s.47 and AML/CTF Rules 9-9","note":"First period 1 July 2026 to 30 June 2027. Each later period is a financial year. Lodge within 3 months after the period ends. The first lodgment is due 30 September 2027. The till does not prepare or file this report."}'::jsonb,
   1,
   NULL, NULL, 'none', 'gte',
   NULL, NULL, false)
ON CONFLICT (report_id) DO NOTHING;
