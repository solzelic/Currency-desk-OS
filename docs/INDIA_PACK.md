# India pack (`pack-in-v1`)

First pack for an FFMC or AD Category-II desk. Home currency INR. The Reserve Bank of India licenses the shop. FIU-IND receives the reports. A new desk that signs up as India points at this pack. A desk that was already open is not moved.

Migration **037** (`server/src/db/migrations/037_pack_in_v1.sql`). 029, 031, 033, 034, 035, and 036 are already on main, so this file stays 037. 027 and 030 still belong to open drafts. If a later rebase finds 037 taken, renumber the file name, the id in `server/src/db/migrations.ts`, and the header in the SQL together. Do not edit the file after it has been applied.

The product prepares the figures. It does not file to FINNET.

## Sources, read 7 Oct 2026

| Source | What it is | As of |
|---|---|---|
| Prevention of Money-laundering (Maintenance of Records) Rules, 2005, rules 3 and 8 | CTR, series, CCR, CBWTR, and the 15th of the next month | Rules text fetched 7 Oct 2026 |
| FIU-IND FAQ | STR not later than seven working days after the entity is satisfied the transaction is suspicious. CTR, CCR, and CBWTR by the 15th. Filing on FINNET (`https://finnet.gov.in`) | fiuindia.gov.in FAQ, fetched 7 Oct 2026 |
| Reserve Bank of India (Know Your Customer) Directions, 2025, for NBFCs (DoR.FIN.REC.No.70/03-10-119/2025-26, 28 Nov 2025) | Walk-in CDD at Rs. 50,000 or more, and any international money transfer. A.P. (DIR Series) Circular No. 16 says a non-bank authorised person follows these directions, not the 2016 KYC Master Direction | rbi.org.in id 12943, updated 29 Dec 2025, fetched 7 Oct 2026 |
| FED Master Direction on Money Changing Activities (updated) | Cash rupees to a resident for foreign notes or travellers cheques: USD 1,000 or equivalent per transaction. Cash for a sale of foreign exchange: below Rs. 50,000 | rbi.org.in id 11518, updated 29 Sep 2026, fetched 7 Oct 2026 |
| PMLA section 12 | Records kept five years | Cited from the directions' retention paragraph and the Act |

The 2016 KYC Master Direction (id 11566, updated 14 Aug 2025) has the same 50,000 and international-transfer lines. It is the wrong instrument for an FFMC. The NBFC directions are the ones encoded.

## Rule against what the pack does

| Rule | Implementation |
|---|---|
| Home currency INR. Regulator RBI for the licence, FIU-IND for the reports | `pack-in-v1`. Regulator string `RBI / FIU-IND` |
| CTR: cash more than ₹10 lakh. Comparator is `gt`. Exactly ₹10 lakh is not a CTR | Report `rpt-in-ctr`, trigger 1000000 INR, `gt` |
| Integrally connected cash in a calendar month aggregating to more than ₹10 lakh. At least two deals, each below ₹10 lakh | Stored as `window_kind = calendar_month`. `indiaCtrFindings` can group by customer id inside the Asia/Kolkata month, and nothing calls it. The desk does not sum the month. Same customer would be an approximation, not "integrally connected" |
| CTR due by the 15th of the next month | `deadline_unit = monthly_day`, value 15 |
| Walk-in CDD at ₹50,000 or more, single transaction | `fx` line 50000, `gte`, diligence `cdd`. The posting gate on this pack reads that line |
| Any international money transfer | `remittance` and `eft` lines are 0, which means every deal |
| STR within 7 working days of concluding suspicion | `rpt-in-str`, 7 `business_days`. No Indian holiday calendar. The count is stored and holidays are not subtracted |
| CBWTR: cross-border wires more than ₹5 lakh, monthly, due the 15th | Catalogue row `rpt-in-cbwtr`, `gt`, `calendar_month`. Not auto-filed. A domestic wire is not separated from a cross-border one |
| CCR: counterfeit notes used as genuine. No amount. Due the 15th | Catalogue row `rpt-in-ccr`. The till cannot mark a note counterfeit, so nothing raises it |
| Retention 5 years (PMLA s.12) | `retention_years = 5`. The product does not delete |
| Cash sale of foreign exchange: cash only below ₹50,000 | `indiaSaleCashBlocked` on an India exchange when the customer pays INR and receives foreign notes, at 50000 or more. One deal. No journey id, so several drawals for one journey are not summed |
| Cash payout to a resident: at most USD 1,000 per purchase | `residentCashPayoutWithinLimit` is tested and is not called from posting. There is no residency flag. A visitor may receive up to USD 3,000, so refusing every payout over 1,000 would be the wrong rule |

`jurisdiction_packs.aggregation_hours` is NULL on this pack. NULL means there is no hour window. The month lives on the CTR row. Other packs still store 24.

## What is not done

- Connected cash in a calendar month is not summed. `indiaCtrFindings` exists and is tested. Posting and the browser do not call it. The desk must check those deals. Same customer in the Asia/Kolkata month would be an approximation, not "integrally connected".
- Connected walk-in deals that "appear to be connected" under the KYC directions are not summed. `jurisdiction_id_thresholds` has no window column, and none was added.
- Several cash drawals for one journey are not summed.
- Seven working days do not skip Indian public holidays.
- CCR cannot be flagged from the till.
- CTR, STR, CBWTR, and CCR are not sent to FINNET.
- A USD/EUR cross has no rupee leg, so it is not valued for a CTR. The rules allow a foreign-currency equivalent and do not name a rate source. The shop board is not used.
- The browser does not add up the calendar month. It says so. It does not fall back to 24 hours. A single cash amount uses "more than" when the large-cash report says `gt`.
- The browser identification nudge still follows the single 50,000 line. A one-rupee remittance is refused by the server and may not be nudged on the screen.
- A remittance line of 0 means every deal. The thresholds reader treats 0 as unset, so Settings does not show a remittance amount. The posting gate does not use that reader for India.
- Virtual currency uses the 50,000 walk-in line. The till does not book it. There is no separate virtual-currency regime.
- CKYCR, PAN, beneficial-owner percentages, and the digital KYC app are out of scope.
- The website says the rules are on a new desk and that filing is not live. Canada remains the only Live jurisdiction.
