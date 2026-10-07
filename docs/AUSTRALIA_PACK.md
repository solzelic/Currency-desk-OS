# Australia pack, version 2

`pack-au-v2` is the Australia rulebook the till opens on. `pack-au-v1`
is published and is not edited. A desk already pointing at v1 stays
there until an owner with `compliance:thresholds` calls
`POST /api/ledger/jurisdiction-pack/au-v2`. That update changes the
legal entity's pack id and version only. It does not update
`ledger_transactions`, and it does not clear a number the desk saved
for itself.

Migration `034_pack_au_v2.sql` inserts the new pack. Open drafts were
already using migrations around 029 to 033, so this one is 034. If one
of those drafts lands on 034 first, renumber this file to the next free
id and register that id in `server/src/db/migrations.ts`. Do not edit a
migration that has already been applied.

The pack column `aggregation_hours` is 24 because that column cannot be
null or zero. It is not the threshold-transaction rule. The TTR row's
`window_kind` is `none`, and that is what the till reads.

## Act section and what the till does

| Act | Rule | What v2 does |
| --- | --- | --- |
| s.6 table 1 item 50, s.28, s.39E items 9 and 10 | A currency exchange is a designated service. Initial customer due diligence before the service, except where s.39E says s.28 does not apply below 1,000 dollars. | Foreign-exchange line 1000 AUD, at or above, diligence `cdd`. Not zero. |
| s.6 table 1 items 29 and 30 | Accepting a transfer-of-value instruction, or making value available. No amount. | Remittance and electronic-transfer lines are 0. Every deal. A bill payment uses the electronic-transfer line. |
| s.6 table 1 items 27 and 28 | A money order is designated when the face value is not less than 1,000 dollars. | Applied in code at 1,000 AUD. Not a fifth `deal_kind`. |
| s.6 table 1 items 50A and 50B | Virtual-asset exchange. No 1,000 dollar exemption in s.39E. | Identification line 0. The till does not book virtual assets. |
| s.43, s.5 "threshold transaction" | Physical currency of 10,000 dollars or more, received or paid, one transaction. Within 10 business days after the day it takes place. | TTR, direction `both`, window `none`, 10 business days, cash only. The browser counts cash in and cash out. It does not add deals together. |
| s.41(2) | Terrorism financing: 24 hours after the time the suspicion is formed. Otherwise 3 business days after the day it is formed. | Two catalogue rows, `SMR` and `SMR-TF`, because one code holds one deadline. The till does not decide the suspicion. |
| ss.45 and 46 | International value transfer service (the report formerly called an IFTI). No amount. Within 10 business days after the message is passed on or received. | IVTS row, direction `both`, no trigger amount. The transfer screen lists every transfer. |
| s.47, AML/CTF Rules 9-9 | Compliance report for a reporting period, lodged in the period the Rules set. | `COMPLIANCE` row. Deadline left unset, because the units cannot say "3 months after 30 June". The note says the first lodgment is due 30 September 2027. The till does not prepare it. |
| s.107 | Transaction records kept for 7 years beginning the day the record is made. | `retention_years` 7, as v1 already had. |
| Exemptions Rules chapter 31 | The Act does not apply to item 50 for a short-term accommodation provider, within 500 dollars per guest per day and 1,000 dollars per room account per day, charged to the room, and no other designated service. | Not encoded. This product is a bureau, not a hotel. |

A desk's saved identification number replaces the foreign-exchange line,
including a looser one. The screen already calls a looser line looser.
That number must not lift the remittance line off zero. Cheque cashing
is not item 50. It stays on the single identification column, which v2
still sets at 1,000 AUD.

Business days follow Act s.5: not a Saturday, not a Sunday, and not a
holiday the caller passes in. No Australian public-holiday calendar is
shipped. The due date returned for "10 business days after the day" is
the tenth business day after the transaction's civil day. The
transaction day itself is not day one.

## Sources, as read

- Anti-Money Laundering and Counter-Terrorism Financing Act 2006 (Cth),
  compilation in force 1 July 2026.
  https://www.legislation.gov.au/C2006A00169/2026-07-01
  Sections 5, 6 (table 1 items 27, 28, 29, 30, 50, 50A, 50B), 28, 39E,
  41, 43, 45, 46, 47, 107.
- AUSTRAC, Threshold transaction reports. Page last updated 1 July 2026.
  Receiving or paying physical currency, each transaction separate,
  within 10 business days.
  https://www.austrac.gov.au/industry-and-business/obligations-and-guidance/your-amlctf-program/reporting-us/threshold-transaction-reports
- AML/CTF Rules, Rules 9-9, substituted by F2026L00353 (24 March 2026).
  First reporting period 1 July 2026 to 30 June 2027. Lodge within 3
  months after the period ends.
- Anti-Money Laundering and Counter-Terrorism Financing Rules Instrument
  2007 (No. 1), F2007L01000, as at 31 March 2026, chapter 31
  (accommodation providers).
- AUSTRAC on the IVTS transition. Section 46 reporting is deferred until
  31 March 2029, or a substitute date no earlier than that and no later
  than 30 September 2029 where the entity filed at least one IFTI before
  31 March 2026. Until then the pre-31 March 2026 IFTI obligation
  continues. The catalogue uses the current name and does not also seed
  an IFTI row.

Read on 7 October 2026.

## Gaps

- The full s.28 matters (beneficial owner, politically exposed person,
  sanctions, nature and purpose) are still the existing verified-identity
  gate. This pack does not add a new identity product.
- Simplified due diligence, enhanced due diligence, and s.29 (due
  diligence after the service starts, in the special cases the Rules
  allow) are not modeled. s.39E says enhanced due diligence still applies
  where the 1,000 dollar exemption would otherwise. The till does not
  detect that case, so a sub-1,000 exchange by a customer who should be
  on enhanced due diligence is not forced back up.
- A currency exchange under 1,000 dollars that is neither physical
  currency nor a movement into an ADI account is not covered by s.39E
  items 9 and 10. The 1,000 dollar line applies to every exchange, so
  that residual case is slightly looser than the Act. A bureau's ordinary
  deal is cash. Gold-plating every small card exchange was rejected.
- s.41(2)(aa), the 5 business day privilege case, is named on the SMR
  row and is not a third detector.
- s.46(3): no report if, within the 10 days, the entity determines the
  transfer will not occur and takes reasonable steps to stop it. Not
  detected.
- s.46A, the unverified self-hosted virtual-asset wallet report, is out
  of till scope.
- The annual compliance report is not prepared or filed.
- Nothing is submitted to AUSTRAC. A filing sealed in the ledger is still
  a record, not a lodgment.
- The structuring watch is a product watch. It is not an SMR.
- The browser cannot translate a foreign-to-foreign cash leg on an AUD
  desk (Act s.18). When one leg is AUD, that leg is the figure. When
  neither leg is AUD, the screen does not invent a rate.
- Public holidays are not bundled. A desk that needs a holiday excluded
  has to pass that date. The screen's "10 business days" sentence does
  not compute a holiday calendar.
- The settings hour box can still store a number. For this pack the TTR
  row wins, and deals are not added together.
- IVTS section 46 filing is deferred, as the sources section says. The
  old IFTI forms are not generated either.
