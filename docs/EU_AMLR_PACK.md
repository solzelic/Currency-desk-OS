# EU AMLR 2027 pack

`pack-eu-v2` is the European Union pack for Regulation (EU) 2024/1624
(the AMLR). It applies from 10 July 2027. `pack-eu-v1` is unchanged.
A desk already on version 1 stays there until the owner opts in.
A new signup that says European Union, Eurozone, or EU opens on
version 2, in euros.

This is one EU pack. Per-member-state extras are a later layer.
Non-euro member states are not converted: a desk that picks European
Union keeps its books in EUR. Thresholds in local currency belong on
that later layer.

## What the pack enforces

| Rule | Source | How it is stored |
| --- | --- | --- |
| A bureau de change is an obliged financial institution | AMLR Art 2(1) point (6)(a) and Art 3 point (2) | The pack exists for those desks. No extra licence gate. |
| Occasional cash transaction of at least EUR 3,000: identification | Art 19(4), Art 20(1)(a) | `cash_identify`, deal kind `any`, 3000 EUR, `gte`, identify, cash only |
| Occasional transaction of at least EUR 10,000: full customer due diligence | Art 19(1)(b), Art 20 | `occasional_cdd`, deal kind `any`, 10000 EUR, `gte`, cdd |
| Transfer of funds of at least EUR 1,000: customer due diligence | Art 19(2) | `transfer_cdd` on remittance and on eft, 1000 EUR, `gte`, cdd |
| Suspicious transaction report, any amount, including an attempt | Art 69 | `rpt-eu-str-v2`, kind `suspicious`, no trigger amount |
| Reply to an FIU information request within 5 working days | Art 69 | Words on `format_rules.deadline_label`. Not a filing deadline. |
| Keep records 5 years | Art 77 | `retention_years` 5, from the end of the relationship or the occasional transaction |
| Applies from 10 July 2027 | Art 90 | `applies_from` 2027-07-10. Until that date the desk shows a disclaimer that national law, including transposition of the fourth and fifth directives, still governs |

The official Art 19(2) text says "at least EUR 1 000". The pack uses
`gte` (at or above). A survey that said "more than EUR 1,000" does
not match the Official Journal.

There is no European Union large-cash report. `report_threshold` is
stored as 0 so the reader treats it as absent. `report_name` is empty
so a screen does not label the suspicious-transaction report as a
large-cash report. The posting path does not demand purpose and source
of funds on every deal just because that figure is absent. It demands
them when a customer-due-diligence line is hit. Article 20(1)(f) says
source of funds "where necessary"; the product already captures purpose
and source of funds as a pair, and both are required when that line hits.

The desk's own identification number replaces only `cash_identify`.
It may be tighter or looser, which is the same rule the other packs
already follow for their single identification number. The transfer
line and the 10,000 line are not moved by that box.

A cashed cheque is not treated as the Article 19(4) cash transaction.
The occasional 10,000 line still applies to it.

Customer due diligence on a transfer of at least 1,000 EUR is enforced.
The remittance send already asks for the beneficiary's name. The payer
is the customer. Account number and address stay in the browser's
beneficiary book. They are not a travel-rule payload on the ledger.
Regulation (EU) 2023/1113 is not fully stored.

## What it deliberately does not do

- Linked transactions. Article 19(1)(b) covers a single transaction or
  linked ones. The criteria are a draft AMLA regulatory technical
  standard (consultation 2025, adoption by the Commission still
  required under Art 19(10)). The pack does not hard-code a count of
  transactions or a lookback window. `aggregation_hours` is null.
- Article 80 cash payment limit of EUR 10,000 for payments in exchange
  for goods or services. Whether that bites on a bureau changing cash
  for cash is a counsel question. Bureaux de change are not in the
  Art 80(4)(b) exclusion for credit institutions, e-money issuers, and
  payment service providers. The pack does not block a deal and does
  not invent a 10,000 cash report from Art 80(4)(b).
- Suspicion at any amount triggering customer due diligence
  (Art 19(1)(d)). That is a person's judgement. It is not automated.
- A virtual-currency line at 1,000. A virtual-currency deal is covered
  by the two `any` lines only. Adding a 1,000 line would be extra.
- A second signup path. New desks use the existing provision path.
- Editing `pack-eu-v1` or `rpt-eu-str`.

## Opt-in

`POST /api/ledger/jurisdiction-pack/eu-amlr` moves a desk from
`pack-eu-v1` to `pack-eu-v2` version 2. It needs
`compliance:thresholds`. It writes `compliance.pack.opt_in`. It does
not rewrite posted deals and it does not clear the desk's own
threshold numbers. Any other pack is refused.

## Migration number

`031_pack_eu_amlr.sql`. Main ended at 028. Open drafts may already
claim 027 (terms), 029 (Canada pack, and a rate-board migration), and
030 (cost rebase). 031 was free of those files. If a rebase finds 031
taken, renumber this file. Do not edit an applied migration.

## Sources

Checked 7 October 2026.

- Regulation (EU) 2024/1624, Official Journal English XHTML,
  publications.europa.eu cellar
  `868bf3cf-2dd4-11ef-a61b-01aa75ed71a1.0006.03/DOC_1`.
  OJ last-modified 19 June 2024. ELI:
  https://eur-lex.europa.eu/eli/reg/2024/1624/oj
  (the HTML and PDF on EUR-Lex returned an empty challenge page from
  this environment; the cellar XHTML is the text that was read).
- Regulation (EU) 2024/1620 (AMLA) and Directive (EU) 2024/1640
  (AMLD6) are the rest of the package. They are not encoded as extra
  thresholds. AMLD6 is the directive member states transpose; the
  pack is the regulation, which applies directly from 10 July 2027.
- Regulation (EU) 2023/1113 (transfer of funds). Customer due
  diligence is aligned at 1,000 EUR. Payer and payee information
  beyond the beneficiary name is the gap above.
- AMLA draft RTS on customer due diligence, including linked
  transactions. The consultation page did not return body text from
  this environment on 7 October 2026. Article 19(10) still requires
  Commission adoption. The draft criteria are not in the pack.
