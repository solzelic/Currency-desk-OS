# United Arab Emirates pack, version 2

An exchange house. Not a dealer in precious metals and stones, and not
a hawala provider. `pack-ae-v1` is unchanged. A desk already on it stays
there until an administrator opts in. A new UAE desk opens on
`pack-ae-v2`. A posted deal keeps the pack id stamped on it.

Migration `036_pack_ae_v2`. 029, 031, 033, 034, and 035 are already on
main, so 036 stays. 027 and 030 are still open drafts. Do not edit an
applied migration.

## What is enforced

| Rule | Where it comes from | What the till does |
| --- | --- | --- |
| No cash threshold report at AED 55,000 | That figure is not an exchange-house cash report. See sources. | `report_threshold` is 0, which the reader treats as no amount. No `large_cash` row. A blank reporting box does not demand purpose and source of funds on every foreign exchange. |
| Foreign exchange identification at AED 3,500 or more | Exchange Business Standards 16.7 and 16.8.1. One deal. "Or more" is `gte`. | Unverified customer: 3,499.99 posts, 3,500.00 does not. A desk number strictly below 3,500 tightens (`gte`). A number of 3,500 or more is refused in Settings and ignored if it is already stored. |
| One foreign exchange of AED 35,000 or more: purpose and source of funds | Standards 16.9.1, the one-deal half. | A verified customer can post 34,999.99 without those fields. 35,000.00 cannot. The frozen-quote path checks this for this pack only. |
| Money transfer: identification, purpose, and source of funds at any amount | Standards 16.7 and 16.9.1. | Remittance and electronic transfer rows are threshold 0, diligence `cdd`. The gate identifies every such deal. Purpose and source of funds are required at any amount, including 0.01. |
| Money order and bill payment | Not a separate Chapter 16 line. | The existing mapper already treats a money order as a remittance and a bill payment as an electronic transfer, so they follow the money-transfer line. |
| Cheque cashing | Not in the 16.7 table. | The existing mapper treats it as foreign exchange, so identification is AED 3,500. Purpose and source of funds are not required. |
| STR and SAR | Standards 16.27. Cabinet Resolution 134 of 2025, Article 18. | Catalogue rows. Kind `suspicious`. No amount. Deadline immediately, through goAML. The till does not file them. |
| Fund Freeze Report | Standards 16.25. Confirmed match. | Catalogue row. 2 business days, goAML. The till does not file it and does not run the freeze. |
| Partial Name Match Report (PMNR) | Standards 16.25. Potential match. | Catalogue row. No counted deadline: suspend until goAML answers. PNMR is the same report. The till does not file it. |
| Records kept at least 5 years | Cabinet Resolution 134 of 2025, Article 25. | `retention_years` is 5. |
| Opt-in | This product's rule for a new pack version. | `POST /api/ledger/jurisdiction-pack/ae-v2`, permission `compliance:thresholds`. Only from `pack-ae-v1`. Already on v2 is a no-op. Any other pack is 409 `JURISDICTION_PACK_CONFLICT`. Desk numbers are not rewritten. Audit action `compliance.jurisdiction_pack.adopt`. |
| Virtual currency | Chapter 16 states no line for this business. | Threshold NULL. The gate identifies. The till does not book the product. |

`aggregation_hours` stays 24 because the column cannot be empty and cannot hold 90 days. Report rows say `window_kind` `none`. 24 is not the 90 day rule.

The single `id_threshold` column is 3,500, which is what the Settings box compares against. The posting gate reads `jurisdiction_id_thresholds`, not that column.

## Known gaps

These are in the Standards and are not implemented. Encoding them would invent a store the schema does not have, or a judgment the Standards leave to a person.

- Foreign exchange of AED 35,000 or more, and of AED 55,000 or more, when the figure is several deals in 90 days (Standards 16.9 and 16.10). Only the one-deal half of 16.9 is enforced, at 35,000.
- Money transfers of AED 55,000 or more, one deal or several in 45 days, which call for enhanced due diligence (Standards 16.10). Purpose and source of funds are already required at any amount. The extra evidence is not a stored field.
- Enhanced due diligence evidence (bank statements, and evidence where there is doubt) at the 55,000 band. Not a till field.
- Standards 16.16.3: a person who repeatedly exchanges below 3,500. The example is once a week. That is a judgment, not a sum.
- Occasional transactions that appear to be linked (Cabinet Resolution 134 of 2025, Article 7). A judgment, not a sum.
- Legal persons, PEPs, and high-risk customers: customer due diligence and enhanced due diligence at any value (Standards 16.7). Not this pack's counter rule.
- A hawala or registered hawala provider table that identifies only, for a transfer between AED 1 and 3,499. That is a different product. This pack follows 16.7: a money transfer is customer identification and customer due diligence at any amount.

## Sources

Read 2026-10-07.

- CBUAE Rulebook, Chapter 16, Exchange Business Standards, version 1.20 (November 2021), status In-Force. https://rulebook.centralbank.ae/en/rulebook/16-exchange-business-standards and section 16.7, 16.8, 16.9, 16.10, 16.16, 16.25, 16.27. The rulebook still cites Notice No. 35/2018. It was not re-fetched as a new instrument under Federal Decree-Law No. 10 of 2025.
- CBUAE Rulebook 6.2.2, occasional transactions. The text cites Article 6 of the AML-CFT Decision: customer due diligence at AED 55,000 (single or linked) and wire transfers at AED 3,500. That page is the general rulebook, not an exchange-house cash report. https://rulebook.centralbank.ae/en/rulebook/622-occasional-transactions
- Cabinet Resolution No. 134 of 2025 (the executive regulations under Federal Decree-Law No. 10 of 2025), as carried on the CBUAE rulebook and uaelegislation.gov.ae. Article 3(3) is the precious-metals cash report at AED 55,000. Article 6 is when identity is verified. Article 7.2(a) is occasional customer due diligence at AED 55,000, single or linked. Article 7.2(b) is wire transfers at AED 3,500. Articles 17 and 18 are the suspicious report, immediately, through the FIU electronic system. Article 25 is retention of not less than five years.
- Cabinet Decision No. 10 of 2019, Article 6, was the earlier occasional-transaction customer due diligence trigger. Cabinet Resolution 134 of 2025 replaced that numbering. Do not cite Article 6 of the 2025 resolution as the 55,000 line.
- Federal Decree-Law No. 10 of 2025. The fetched text requires records to be kept pursuant to the Executive Regulations. It does not itself state "five years". The five-year rule used here is Article 25 of Cabinet Resolution 134 of 2025.
- UAE Financial Intelligence Unit, goAML, as the channel named in the Standards for STR, SAR, FFR, and PMNR. https://www.uaefiu.gov.ae/

## Unsure

- Whether Exchange Business Standards Chapter 16 has been formally reissued under Decree-Law 10 of 2025. The rulebook page still says In-Force, Notice 35/2018, version 1.20. This pack follows that in-force text.
- Standards 16.8.1 says foreign-exchange identification runs up to AED 34,999.75, while the 16.7 table says less than 35,000. The gate uses at or above 3,500 and, for purpose and source of funds, at or above 35,000. It does not encode the 0.25 fils bound.
- Whether a bill payment or a money order should legally follow the money-transfer line. They do here because the deal-kind mapper already sends them there. Chapter 16 does not name them separately.
