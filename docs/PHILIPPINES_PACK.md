# Philippines pack (`pack-ph-v1`)

First pack for a money changer, foreign-exchange dealer, or remittance
agent. Home currency PHP. Regulator string `BSP / AMLC`. A new desk that
signs up as the Philippines gets this pack. A desk that is already open
is not moved. The website stays **Not live**. Canada is the only Live
country. The desk does not file to the AMLC and does not prepare an
AMLC form.

Read 7 Oct 2026. The statute and the BSP text do not say the same thing
about a banking day. That doubt is at the bottom.

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
| Banking-day total over 500,000 PHP | Gap | The statute has the total. The till flags one deal and does not add the day |
| Two or more deals believed to be linked, over 5,000 or over 100,000 | Gap | Not summed |
| Monthly sale cap of 50,000 USD per customer | Gap | Not summed |
| BSP exemption to sell more than 10,000 USD | Gap | A shop with an exemption is still refused above 10,000. Fail closed |
| Appendix N-8-c documents on a sale | Gap | The till does not collect them |
| BSP registration / certificate of registration | Gap | Not tracked |
| Sanctions and targeted financial sanctions | Gap | No list ships. The desk does not claim it screened anyone |
| Wire originator and beneficiary information | Gap | Not a report the till builds |
| AMLC low-risk deferral of some covered transactions for money service businesses | Gap | The deferral list was not confirmed, so nothing is deferred. A flagged cash deal over 500,000 may include an instrument the AMLC defers |
| 2018 IRR Rule 18 section 3.2, first-time identification at any amount | Gap | Not applied below the BSP occasional lines. The till's only identification state is verified or not |

## Sources

- Republic Act 9160 (AMLA), section 3(b), as amended by RA 11521 section 2. A covered transaction is a transaction in cash or other equivalent monetary instrument involving a total amount in excess of 500,000 pesos within one banking day. Casinos and real estate have higher lines. Those are not this desk. Statute text: Lawphil and the Supreme Court e-library.
- 2018 Implementing Rules and Regulations, as amended, Rule 3, covered transaction: a transaction in cash or other equivalent monetary instrument exceeding 500,000 pesos. The banking-day total is not restated in the Legaldex consolidation or in the AMLC Anti-Money Laundering and Counter-Terrorism Financing Guidelines text that was read. Rule 22 section 2.1: covered transaction reports within five working days from occurrence, unless the AMLC prescribes a different period not exceeding 15 working days. Rule 18 section 1.2 lets the supervising authority set a threshold other than 100,000 pesos. Rule 18 section 3.2 is the first-time identification sentence that this pack does not enforce.
- AMLC amendment of the 2018 IRR, effective 1 February 2020 (amlc.gov.ph): a suspicious transaction is filed within the next working day from the date suspicion is established.
- BSP Manual of Regulations for Non-Bank Financial Institutions, Part IX, updated 31 December 2023. Section 904(c) defines a covered transaction as one transaction exceeding 500,000 pesos and does not restate the banking day. Section 921(d) is the relevant-business-transaction line: exceeding 100,000 pesos, except money changing or remittance; remittance and money changing exceeding 5,000 pesos. Section 922 states both covered and suspicious reports within five working days. Section 924 is five-year record keeping. The scope of Part IX includes foreign-exchange dealers, money changers, and remittance and transfer companies.
- BSP Circular 942 (2017), MORNBFI section 4511N.9. Large-value payouts of more than 500,000 pesos, or the foreign-currency equivalent, in any single transaction, only by cheque or direct credit. Sale of foreign currency not exceeding 10,000 USD or its equivalent per transaction, and not exceeding 50,000 USD per month per customer. The month is not summed.
- BSP Circular 1170 (2023) amends identity (PhilSys). It does not change these amounts.
- AMLA section 9(b): records for five years.

The market snapshot used for a foreign-currency equivalent is the same CAD-per-unit table the rate sync stores, not older than 24 hours. PHP per unit is CAD per unit divided by CAD per PHP.

## Doubt

RA 11521 section 3(b) requires a total in excess of 500,000 pesos within one banking day. The 2018 IRR as amended, and BSP MORB section 904(c) as of 31 December 2023, define a covered transaction as one transaction exceeding 500,000 pesos and do not restate that window. An implementing rule cannot repeal the statute. The AMLC's own definition dropped the window. This pack stores `window_kind = banking_day` and enforces only the single-deal limb, which is a covered transaction under both texts. Exactly 500,000 is in neither reading. What a "banking day" is (a BSP banking day, or a day the shop is open) does not change posting, because the day is not summed.

A second doubt: the STR clock. The AMLC 2020 amendment says the next working day from determination. MORB section 922 (31 December 2023) still says five working days for both reports. The row stores one business day, the AMLC clock. The desk does not file either way.

A third: whether "money changing" in section 921(d)(3) includes foreign-exchange dealing as a separate word. Circular 942 treats money changers and foreign-exchange dealers as one category. This pack applies 5,000 pesos to exchange and to remittance. It does not apply 5,000 to cheque cashing or to a bill payment.
