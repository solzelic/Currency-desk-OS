# Philippines pack (`pack-ph-v1`)

First pack for a money changer, foreign-exchange dealer, or remittance
agent. Home currency PHP. Regulator string `BSP / AMLC`. A new desk that
signs up as the Philippines gets this pack. A desk that is already open
is not moved. The website stays **Not live**. Canada is the only Live
country. The desk does not file to the AMLC and does not prepare an
AMLC form.

Read 7 Oct 2026, and again for the banking-day texts. The stricter
reading is a total within one banking day. It is Listed. The till does
not add the day. The open question is stated below.

## What the till enforces

| Rule | Line | Comparator | Where |
| --- | --- | --- | --- |
| Money changing and remittance, customer due diligence | 5,000 PHP | more than | `fx` and `remittance` rows. Exchange, remittance send and receive, money order |
| Other occasional deals, customer due diligence | 100,000 PHP | more than | `eft` and `virtual_currency` rows. Bill payment, electronic transfer, cheque cashing, virtual currency |
| Covered transaction | 500,000 PHP | more than | One deal. Flagged. Not summed across a banking day |
| Purpose and source of funds | 500,000 PHP | more than | Same line as the covered transaction. Not at 5,000 |
| Cash payout | 500,000 PHP, or the foreign-currency equivalent | more than | Exchange cash out, remittance receive, cheque net. A cheque or a bank credit is not this block |
| Sale of foreign currency | 10,000 USD, or the equivalent | not exceeding (10,000 allowed) | Customer pays PHP and receives foreign notes. One transaction |

Exactly 5,000, exactly 100,000, exactly 500,000, and exactly 10,000 USD
are allowed. The next centavo, or the next US cent, is not.

A 1.00 PHP unverified remittance is allowed. That is the live row.
Zero on a threshold row means every deal, and a missing row blocks.
Those two are tested on their own. They are not the live remittance line.

A desk may set a lower identification line. That tighter number is
"at or above". A desk line equal to or above the pack line is ignored,
so the desk cannot lift a deal off the pack line.

Money is `Decimal`. A converted amount is compared before it is rounded.
Rounding down before a "more than" test can allow a deal that is over.
A missing or stale market rate blocks a foreign-currency cash payout
and a non-dollar sale. It does not allow them. The shop's board mid is
not the legal rate. A cross with no peso leg and no fresh rate is not
posted, including for a customer who is already verified.

`aggregation_hours` is NULL. NULL is not 24. The banking day is
`window_kind` on the covered-transaction row. The till does not add
that day up.

Records: `retention_years` is 5. Nothing is deleted.

## What is listed or a gap

| Item | Tag | Why |
| --- | --- | --- |
| Suspicious transaction, next working day from the date suspicion is established | Listed | The clock is stored. The desk does not decide suspicion and does not file. Philippine holidays are not subtracted |
| Five-year retention | Listed | The number is stored. The product does not delete records, including when a case is in court |
| Banking-day total over 500,000 PHP | Listed | Stricter reading of RA 11521 section 2: a total in excess of 500,000 pesos within one banking day. AMLC Regulatory Issuance No. 1, Series of 2021 (30 January 2021), and MORB section 904(c) (31 December 2023) state one transaction and do not restate the day. The open question is whether those texts narrowed the statute. The till flags one deal and does not add the day |
| Two or more deals believed to be linked, over 5,000 or over 100,000 | Gap | Not summed |
| Monthly sale cap of 50,000 USD per customer | Gap | Not summed |
| BSP exemption to sell more than 10,000 USD | Gap | A shop with an exemption is still refused above 10,000. Fail closed |
| Appendix N-8-c documents on a sale | Gap | The till does not collect them |
| BSP registration / certificate of registration | Gap | Not tracked |
| Sanctions and targeted financial sanctions | Gap | No list is loaded. The sample names are not shown. The desk tells the owner that Philippine law requires screening clients and counterparties against the UNSC Consolidated List and the ATC list. On a match, freeze without delay, tell the AMLC the same day, and file an STR. The owner does that outside the desk |
| Wire originator and beneficiary information | Gap | MORB section 923 sets what must travel with a transfer, including a 50,000 peso information line. The till does not build that message |
| AMLC low-risk deferral of some covered transactions for money service businesses | Gap | The deferral list was not confirmed, so nothing is deferred. A flagged cash deal over 500,000 may include an instrument the AMLC defers |
| 2018 IRR Rule 18 section 3.2, first-time identification at any amount | Gap | Not applied below the BSP occasional lines. The till's only identification state is verified or not |

## Sources

- Republic Act 9160 (AMLA), section 3(b), as amended by RA 11521 section 2. A covered transaction is a transaction in cash or other equivalent monetary instrument involving a total amount in excess of 500,000 pesos within one banking day. Casinos and real estate have higher lines. Those are not this desk. Statute text: Lawphil and the Supreme Court e-library.
- AMLC Regulatory Issuance A, B, and C No. 1, Series of 2021 (30 January 2021, AMLC Resolution No. 27, Series of 2021). It amends Rule 2 section 1(w)(1) of the 2018 IRR: a covered transaction is a transaction in cash or other equivalent monetary instrument exceeding 500,000 pesos. That sentence does not say within one banking day. Rule 22 section 2.1: covered transaction reports within five working days from occurrence, unless the AMLC prescribes a different period not exceeding 15 working days. Rule 18 section 1.2 lets the supervising authority set a threshold other than 100,000 pesos. Rule 18 section 3.2 is the first-time identification sentence that this pack does not enforce.
- AMLC amendment of the 2018 IRR, effective 1 February 2020 (amlc.gov.ph): a suspicious transaction is filed within the next working day from the date suspicion is established.
- BSP Manual of Regulations for Banks (MORB), Part IX, updated 31 December 2023. This is the banks manual. Section 903 applies that part to covered persons the Bangko Sentral supervises, and it names foreign-exchange dealers, money changers, and remittance and transfer companies in that list. Section 904(c) defines a covered transaction as one transaction in cash or other equivalent monetary instrument exceeding 500,000 pesos, and it does not restate the banking day. Section 921(d) is the relevant-business-transaction line: a transaction exceeding 100,000 pesos, except money changing or remittance; two or more transactions believed to be linked and aggregating over 100,000 pesos; and, for remittance and money changing, any transaction or two or more believed to be linked, exceeding 5,000 pesos. Section 922 states both covered and suspicious reports within five working days from occurrence, unless the AMLC sets a different period not exceeding fifteen working days. For a suspicious transaction, occurrence is the date of determination. Section 923 (fund and wire transfer) sets originator information at 50,000 pesos. That information rule is not built. Section 924 is five-year record keeping. A separate MORNBFI consolidation of section 921 was not the text read. Circular 942, below, is the non-bank sale and payout rule.
- BSP Circular 942 (2017), MORNBFI section 4511N.9. Large-value payouts of more than 500,000 pesos, or the foreign-currency equivalent, in any single transaction, only by cheque or direct credit. Sale of foreign currency not exceeding 10,000 USD or its equivalent per transaction, and not exceeding 50,000 USD per month per customer. The month is not summed.
- BSP Circular 1170 (2023) amends identity (PhilSys). It does not change these amounts.
- AMLA section 9(b): records for five years.
- BSP Circular 1182 (10 November 2023), section 921. A covered person screens customers, including beneficial owners and persons acting for them, transactors, and counterparties on a wire. The sanctions database includes, at minimum, the UNSC Consolidated List (UNSCR 1267/1989, 1988, and 2253 for terrorism; 1718 and 2231 for proliferation) and Anti-Terrorism Council designations. A potential target match is frozen without delay. The AMLC is told the same day. An STR is filed, including for an attempted deal. This pack loads neither list. The screen states that duty.
- BSP Circular Letter CL-2023-030 (2023), the AMLC Guidance on Sanctions Screening. Covered persons screen against the ATC list and the UNSC Consolidated List.
- BSP Circular Letter CL-2021-013 (10 February 2021). Covered persons apply targeted financial sanctions on the UNSC Consolidated List, including UNSCR 1718 and 2231, freeze a target match, and file an STR for an attempted deal.

The market snapshot used for a foreign-currency equivalent is the same CAD-per-unit table the rate sync stores, not older than 24 hours. PHP per unit is CAD per unit divided by CAD per PHP.

## Doubt

RA 11521 section 2 (29 January 2021), amending RA 9160 section 3(b), is the statute. Lawphil and the Supreme Court e-library give the same sentence: a covered transaction is a transaction in cash or other equivalent monetary instrument involving a total amount in excess of 500,000 pesos within one banking day. Casino and real estate lines in that section are single transactions. They are not this desk.

AMLC Regulatory Issuance A, B, and C No. 1, Series of 2021, is dated 30 January 2021, the day after that statute. Its Rule 2 section 1(w)(1) is a transaction in cash or other equivalent monetary instrument exceeding 500,000 pesos, and it does not say within one banking day. BSP MORB Part IX section 904(c), updated 31 December 2023, also defines one transaction exceeding 500,000 pesos and does not restate the banking day.

No later text read for this pack says the statute dropped the banking day, and none says the 30 January 2021 sentence replaced it. The two texts still differ. The stricter reading is the statute: a total in excess of 500,000 pesos within one banking day. That reading is Listed. The open question is whether the 30 January 2021 issuance, or MORB section 904(c), narrowed the statute to a single transaction. The till flags one deal over 500,000 pesos and does not add the day. The desk must check the day. Exactly 500,000 pesos is not a covered transaction under either text. What a banking day is, a BSP banking day or a day the shop is open, is part of that open question. It does not change posting, because the day is not summed.

A second doubt: the STR clock. The AMLC 2020 amendment says the next working day from determination. MORB section 922 (31 December 2023) still says five working days for both reports. The row stores one business day, the AMLC clock. The desk does not file either way.

A third: whether "money changing" in section 921(d)(3) includes foreign-exchange dealing as a separate word. Circular 942 treats money changers and foreign-exchange dealers as one category. This pack applies 5,000 pesos to exchange and to remittance. It does not apply 5,000 to cheque cashing or to a bill payment.
