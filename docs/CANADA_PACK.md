# Canada pack version 2

Read against the official text on 2026-10-06. The regulations below
were current to 2026-09-21 and last amended 2026-03-26.

- Proceeds of Crime (Money Laundering) and Terrorist Financing Act:
  https://laws-lois.justice.gc.ca/eng/acts/P-24.501/FullText.html
- Proceeds of Crime (Money Laundering) and Terrorist Financing
  Regulations, SOR/2002-184:
  https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/FullText.html
  Section pages used for the lines below:
  s.36 https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/section-36.html
  s.84 https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/section-84.html
  s.95 https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/section-95.html
  s.132 https://laws-lois.justice.gc.ca/eng/regulations/SOR-2002-184/section-132.html
- Suspicious Transaction Reporting Regulations, SOR/2001-317:
  https://laws-lois.justice.gc.ca/eng/regulations/SOR-2001-317/FullText.html
- FINTRAC 24-hour guidance, updated 2023-10-23:
  https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/24hour/1-eng
- FINTRAC large virtual currency transaction report:
  https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/lvctr/lvctr-eng.php
- FINTRAC electronic funds transfer report:
  https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/eft-dt/eft-dt-eng
- FINTRAC listed person or entity property report (the name used from
  2025; the page was updated 2025-03-02 and 2025-10-01):
  https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/guide5/5-eng
- FINTRAC, when to verify identity:
  https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/client/fact-affect-eng.php

`pack-ca-v1` is not edited. Migration 029 inserts `pack-ca-v2` and
adds columns. It does not update a pack row, a report row, an
identification line, or a legal entity.

## Who is on which pack

A new Canada desk opens on `pack-ca-v2`. A desk already on
`pack-ca-v1` stays there. The York seed stays on version 1. Migration
028's backfill still points a CAD book at version 1.

An owner moves that desk from Compliance, Jurisdiction, "Use the
current Canada rules". The route is
`POST /api/ledger/jurisdiction-pack/canada-v2`. It requires
`compliance:thresholds`. It moves only a desk whose pack is
`pack-ca-v1`. The desk's own identification number is left as it is.
Posted deals keep the pack version stamped on them. There is no
downgrade.

On a split pack the settings screen still edits one number, and that
number is the foreign-exchange line. It may replace the CAD 3,000
foreign-exchange and money-order lines, including a looser choice.
It must not lift the CAD 1,000 lines. A lower number tightens every
line.

## What version 2 enforces

Identification, PCMLTFR s.95. Foreign exchange and money orders at
CAD 3,000 or more. A remittance (transmitting funds, or being the
beneficiary of funds, other than an electronic funds transfer), an
electronic funds transfer, and virtual currency at CAD 1,000 or more.
Cheque cashing uses the foreign-exchange line. A cashed cheque is not
cash received.

Large cash, s.30 and s.126, filed within 15 calendar days, s.132(3).
Cash the desk received. The 24-hour total includes every amount in
the window, including one already at CAD 10,000. A single receipt at
the line stays its own report. Two or more that reach the line are
one report, and a receipt inside that report is not also filed alone.
The axes are conducted by, on behalf of, and for the benefit of.
They are not added together. The same set of transactions on two
axes is one report. A partial overlap is two reports.

Identity when a large cash report is required, s.84, including one
that exists only because the window adds up. The gate can refuse the
deal in front of it. It does not unwind a deal that already posted.

Electronic funds transfer report: CAD 10,000, within 5 working days,
s.132(1). FINTRAC's 24-hour guidance still tells this form to leave
a single transfer already at CAD 10,000 out of the aggregate and file
it on its own. Version 2 keeps that older rule for the EFTR only.

Large virtual currency transaction report: s.30(1)(f), s.32, s.129,
within 5 working days, s.132(2). Same 24-hour rule as a large cash
report. The row is in the pack and on the Compliance screen. The
counter does not book virtual currency, so the report does not fire
from a till.

Suspicious transaction report: no amount, as soon as practicable.
The words sit on the report because they are not one of the deadline
units.

Listed person or entity property report: Act s.7.1 and the Suspicious
Transaction Reporting Regulations. File immediately. This is property
of a listed person or a terrorist group. It is not
`SANCTIONS-STOP`, and it is not fired from the toy watchlist.

Foreign-exchange ticket, s.36(i) and s.1(2). At the foreign-exchange
line the record needs the customer's name, address, occupation, and
date of birth, as well as the identity document. An expired document
still blocks the deal. That is a product choice. Section 155 is looser.

Beneficiary, s.36(c.1) to (f). At the remittance line the ledger
stores the beneficiary's name and address. Under the line they are
stored when the teller typed them, and they may be omitted.

## Known gaps

These are not implemented. The pack does not pretend they are.

- A full compliance program. Act s.9.6 and PCMLTFR s.156.
- Ministerial directives as structured rules. Russia, Iran, and the
  DPRK stay a free-text note. The website labels that note, not a
  live rule.
- A politically exposed person determination on an electronic funds
  transfer of CAD 100,000 or more. Section 120.
- A business relationship on the second verification within five
  years. Section 4.1(b).
- Statutory holidays. Working days here are Monday to Friday.
  FINTRAC also drops statutory holidays. There is no holiday
  calendar in the pack.
- The browser lets an owner move the 24-hour anchor off midnight
  (`settings.aggWindowStart`). That choice is not stored on the
  server. The identity gate uses midnight in the branch's time zone,
  `America/Toronto` when the branch has none. The end of the window
  is that instant plus 24 hours.
- Other fields s.36 asks for on a ticket (telephone, the rate, an
  account number) are not stored. The four fields the survey named
  are the ones this pack requires.
- Section 84 also requires identity when a large virtual currency
  report is required. The counter cannot book that instrument, so
  the gate cannot see one.
- A receipt under the line that was posted before the window filled
  is not refused after the fact. The next receipt in the window is.
