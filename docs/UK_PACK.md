# United Kingdom pack (pack-gb-v2)

A bureau de change / money service business. Not a high-value dealer,
not a casino, and not a cryptoasset exchange provider or custodian
wallet provider.

`pack-gb-v1` is unchanged. A desk already on it stays there until an
administrator opts in (`POST /api/ledger/jurisdiction-pack/gb-v2`,
permission `compliance:thresholds`). A new GB or UK desk opens on
`pack-gb-v2`. A posted deal keeps the pack id and version stamped on
it. Opt-in does not rewrite deals and does not clear a number the
desk has typed for itself.

Migration **035**. 029, 031, 033, and 034 are already on main. 027
and 030 are still open drafts, so 035 stays. Do not edit a migration
that has been applied.

## Regulation and what the pack does

Read on 7 October 2026. legislation.gov.uk said the Money Laundering
Regulations page was up to date with changes known on or before
4 October 2026. The sterling figures have been in force since
30 June 2026.

| Rule | Source | What v2 does |
| --- | --- | --- |
| Occasional transaction of £12,000 or more: customer due diligence | MLR 2017 reg 27(2), sterling substituted by SI 2026/621 reg 14(b) | Foreign exchange and virtual currency: at or above £12,000 (`gte`). That amount is a floor. A desk number cannot raise it. |
| Occasional transfer of funds exceeding £800: customer due diligence | MLR 2017 reg 27(1)(b), sterling substituted by SI 2026/621 reg 14(a) | Remittance and electronic transfer: more than £800 (`gt`). £800.00 does not trigger. £800.01 does. |
| No large-cash / currency transaction report | No such duty for a bureau. The £10,000 cash figure is reg 27(3) for a high-value dealer, not this pack. | `report_threshold` is 0, which the reader treats as no amount. There is no `large_cash` report row. A following desk is not asked for purpose and source of funds on that account. |
| Suspicious activity report, no amount, as soon as is practicable | Proceeds of Crime Act 2002 s.330, to a nominated officer or a person authorised by the Director General of the NCA | Report code SAR, name Suspicious Activity Report, kind suspicious, `window_kind` none, filing format NCA SAR Online. The deadline words live on `format_rules.deadline_label`. |
| Records kept five years | MLR 2017 reg 40 | `retention_years` 5. |
| Supervisor | HMRC registers and supervises money service businesses | `regulator` is HMRC. SARs go to the NCA (UKFIU), not to HMRC. |

A desk may still type a lower identification number. That number means
"at or above". It tightens a statutory line only when it is strictly
below that line. A number at or above £12,000 does not raise the
occasional-transaction floor, and Settings refuses to save it. A
number that is not strictly below £800 does not raise the transfer
line. A number the desk types in the reporting box is its own policy.
The law does not require that report. Posture against a pack figure
of "no amount" stays unknown, because there is no statutory
cash-report figure to sit above.

`aggregation_hours` is 24 because the column cannot be empty or zero.
Nothing is added together. The SAR row says `window_kind` none. Linked
occasional transactions ("which appear to be linked") are a judgment,
not a 24-hour sum.

## Sources

- Money Laundering, Terrorist Financing and Transfer of Funds
  (Information on the Payer) Regulations 2017, regulation 27.
  https://www.legislation.gov.uk/uksi/2017/692/regulation/27
  Page reviewed 7 October 2026. Footnotes F1 and F5: £800 and £12,000
  substituted on 30 June 2026 by SI 2026/621.
- Same regulations, regulation 40 (five-year retention).
  https://www.legislation.gov.uk/uksi/2017/692/regulation/40
- Money Laundering and Terrorist Financing (Amendment) Regulations
  2026, SI 2026/621, made 9 June 2026. Regulation 1(2): in force
  21 days after making, which is 30 June 2026, except the later
  articles the instrument names. Regulation 14 substitutes £800 in
  reg 27(1)(b) and £12,000 in reg 27(2).
  https://www.legislation.gov.uk/uksi/2026/621
- Proceeds of Crime Act 2002, section 330.
  https://www.legislation.gov.uk/ukpga/2002/29/section/330
- HMRC supervises money service businesses. The NCA's UK Financial
  Intelligence Unit receives SARs (SAR Online).

## Known gaps

These are not implemented. They are not gold-plating left half done.
They are duties the pack does not automate.

- Reg 27(1)(a): customer due diligence when establishing a business
  relationship, at any amount. The till has no business-relationship
  detector.
- Reg 27(2) linked operations. Not summed.
- Reg 27(1)(c) and (d): suspicion, or doubt about documents. A person
  raises the SAR. There is no amount gate for it.
- Reg 27(8), beneficial owners, reg 33 enhanced due diligence, PEPs,
  sanctions lists, OFSI, HMRC fit and proper, policies, training, and
  the firm-wide risk assessment. Out of this pack.
- Reg 40(4) caps relationship transaction records at 10 years.
  Reg 40(5) requires deletion of personal data after the period unless
  an exception applies. The pack states five years. It does not delete.
- Reg 27(7E) and the cryptoasset travel rule (regs 64C and 64G, also
  moved to £800 by SI 2026/621). Not this bureau. A virtual-currency
  deal on this pack uses the £12,000 occasional line.
- A defence against money laundering (consent) under POCA ss.335 and
  338 is a note on the SAR row. There is no consent workflow. The till
  does not file to the NCA.
- "As soon as is practicable" is not a computed deadline.
- A customer already marked verified is not re-checked at the till.
  That is the existing gate, not a UK exemption.
- A bill payment is mapped to the electronic-transfer line (more than
  £800), and a money order to the remittance line. Cheque cashing is
  mapped to foreign exchange (£12,000 or more). A bill payment that is
  not a transfer of funds in the payment-services sense would only need
  the occasional-transaction line. The mapping follows the deal kinds
  the ledger already uses.
- The quote-post path stores purpose and source of funds but does not
  re-check them against a reporting line. That is true for every pack.
  The direct exchange and the four obligation posts do the check. On
  v2 they require those fields only when the desk has typed its own
  reporting number and the deal is at or above it.
