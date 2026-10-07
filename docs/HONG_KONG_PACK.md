# Hong Kong pack (`pack-hk-v1`)

Read 7 Oct 2026. This is the rule set a **new** Hong Kong desk opens on.
An existing desk is not moved. The public site stays **Not live**.
Canada is the only Live country.

Home currency HKD. Regulator string `C&ED / JFIU`. Record retention
5 years. The desk does not delete records. There is no hour window:
`aggregation_hours` is NULL, and a NULL window is not read as 24.

## What the till enforces

Customer due diligence, before the deal, for a customer who is not
already verified. Comparator `gte`. Decimal, not rounded down before
the test. A missing row, a blank, a value that will not parse, a bad
comparator, or a zero line blocks. Zero means every deal of that kind.
It never means the check is off.

| Deal | Line | Source |
| --- | --- | --- |
| Money changing (`fx`, exchange) | at or above 120000 HKD | AMLO Cap. 615 Schedule 2 s.3(1)(b) |
| Bill, money order, cheque | the same 120000 HKD row | s.3(1)(b), other occasional transaction. The table has no separate kind |
| Wire (`eft`) | at or above 8000 HKD | s.1(4) and s.3(1A)(a) |
| Remittance, send or receive | at or above 8000 HKD | s.3(1A)(a) if it is a wire; s.13 if it is not. See the doubt below |
| Virtual asset transfer | at or above 8000 HKD | s.3(1A)(b), "no less than" HK$8,000 |

Exactly 120000 blocks money changing. 119999.99 does not. Exactly 8000
blocks a wire, a remittance, and a virtual asset transfer. 7999.99 does
not. 0.01 on a live remittance row is allowed. There is no any-amount
identification rule at the counter.

A desk may set a lower line. That tighter number is "at or above", and
only when it is strictly below the line for that kind. A desk line of
50000 tightens money changing and does not lift a remittance, because
50000 is not below 8000. A desk line equal to the pack line, or above
it, is ignored.

An HKD leg is used as written. A cross with no HKD leg uses the newest
market snapshot (CAD per unit), not the shop board. One leg only. An
unverified cross with no fresh rate is refused. A verified customer has
no amount test left, so a missing rate does not refuse them. A book
that is not HKD is refused.

Purpose and source of funds are not hard required. s.2(1)(c) is about
a business relationship, unless it is obvious. The report column is 0
because there is no cash transaction report. The reader treats 0 as
"no cash line". Callers skip the purpose gate so that 0 is not read as
"ask for purpose on every deal".

## Listed, and not done by the desk

Suspicious transaction report, to the JFIU. OSCO Cap. 455 s.25A and
DTROP Cap. 405 s.25A: as soon as it is reasonable to do so. UNATMO
Cap. 575 s.12: as soon as is practicable. Any amount, including an
attempt. The C&ED Guideline on Anti-Money Laundering and
Counter-Financing of Terrorism for Money Service Operators (June 2023),
paragraphs 1.24 and 7.19, says the same timing. No numeric deadline is
stored. The desk does not decide suspicion, does not file, and does
not open STREAMS.

Record keeping, Schedule 2 s.20: transaction records at least 5 years
from completion; customer records throughout the relationship and at
least 5 years after it ends; occasional-transaction customer records
at least 5 years from completion. The product does not delete them.

## Gaps

Wire information, s.12. Any amount needs originator name and account
or unique reference, and recipient name and account or reference. At
or above 8000 HKD it also needs an address, an identification number,
or date and place of birth. The desk does not build the message and
does not refuse a transfer for a missing field. This is not an
identification gate.

Remittance record fields, s.13: identification document number, place
of issue if it is a travel document, recipient address, method of
delivery, date and time of the instructions. Not collected. The amount
gate is enforced separately.

Virtual asset transfer information, s.13A. Not built. The amount gate
is the virtual currency row.

Sanctions. No list is loaded. The sample queue in
`os-src/cdos-compliance.jsx` is fictional and is hidden.
`sanctionsListShips()` returns false for `pack-hk-v1`. The owner must
screen against designated persons under the United Nations Sanctions
Ordinance (Cap. 537) and the United Nations (Anti-Terrorism Measures)
Ordinance (Cap. 575). Guideline chapter 6, paragraph 6.16, also points
at UNATMO ss.8 and 8A and the Weapons of Mass Destruction (Control of
Provision of Services) Ordinance s.4. The owner does this outside the
desk.

Linked occasional transactions, s.3(1)(b) and the guideline paragraph
4.2.4. The duty is stored as "not summed". The desk does not add them.

A business relationship, s.3(1)(a), is customer due diligence before
the relationship, any amount. The product does not know whether a
relationship exists, so it does not block every deal.

Suspicion, or doubts about identity, s.3(1)(d) and (e). That is the
suspicious-transaction path, not a numeric gate.

## Not this desk

Section 3(1B) is an occasional transaction of HK$8,000 or more that is
not a wire and not a virtual asset transfer, and it applies only to a
licensed virtual asset service provider. It is not applied to an MSO.
A C&ED circular on the virtual-asset amendments said the CDD thresholds
in sections 3 and 13 for money changing, wire transfer, and remittance
were unchanged.

Cap. 629, Cross-boundary Movement of Physical Currency and Bearer
Negotiable Instruments. Schedule 4 sets a large quantity at HK$120,000.
A traveller arriving at a specified control point in possession of a
total of **more than** HK$120,000 must declare. That is not a counter
CDD rule and not a cash transaction report. It is not enforced.

There is no large-cash row.

## Sources

- Anti-Money Laundering and Counter-Terrorist Financing Ordinance
  (Cap. 615) Schedule 2, e-Legislation text current on 7 Oct 2026:
  ss.1(4), 2(1)(c), 3(1)(a)(b)(d)(e), 3(1A), 3(1B) (not applied),
  12, 13, 13A, 20(2), 20(3), 20(3A).
- C&ED Guideline on AML/CFT for MSOs, June 2023, paragraphs 4.2.1,
  4.2.3, 4.2.4, 6.16, 7.19, and chapters 8, 10, and 11.
  https://eservices.customs.gov.hk/MSOS/download/guideline/AMLO_Guideline_en.pdf
- Organized and Serious Crimes Ordinance (Cap. 455) s.25A.
- Drug Trafficking (Recovery of Proceeds) Ordinance (Cap. 405) s.25A.
- United Nations (Anti-Terrorism Measures) Ordinance (Cap. 575) s.12.
- United Nations Sanctions Ordinance (Cap. 537).
- Joint Financial Intelligence Unit, https://www.jfiu.gov.hk/en/aboutus.html
- Cross-boundary Movement of Physical Currency and Bearer Negotiable
  Instruments Ordinance (Cap. 629) Schedule 4. Not applied.

## The open doubt

The product has one remittance kind and one verified state. A wire
needs full customer due diligence at or above 8000 HKD (s.3(1A)). A
remittance that is not a wire needs originator identification and
verification at or above 8000 HKD (s.13), and full customer due
diligence at or above 120000 HKD (s.3(1)(b)). This pack asks for the
same verified customer at 8000 HKD for both, because both duties use
that number and the till cannot tell a wire from a non-wire remittance.
A non-wire remittance between 8000 and 119999.99 is therefore held to
the same verified state as a wire. The extra s.13 record fields are
not collected. A domestic electronic transfer is treated as a wire.
A bill, a money order, and a cheque are treated as other occasional
transactions at 120000 HKD.
