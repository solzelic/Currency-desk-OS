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
the rolling 24 hours before the deal, including one already at
CAD 10,000. A single receipt at the line stays its own report. Two
or more that reach the line are one report, and a receipt inside
that report is not also filed alone. The window is measured back
from that deal. It does not reset at midnight. The axes are
conducted by, on behalf of, and for the benefit of. They are not
added together. The same set of transactions on two axes is one
report. A partial overlap is two reports.

A later reversal does not take that cash back out. The reversal is
cash paid out and is not a receipt. The exception is a reversal whose
reason is `booking error, cash not received`. Only a supervisor, a
branch manager, or an administrator can set that reason. The cluster
shows "left out: booking error, cash not received." then
"Set by" the staff name and the branch clock, 12-hour, as in
"16 Jun 2026, 4:00 pm". A reversed deal that still counts shows a reversed
tag on its row. The same reason on a deal already in a prepared or
filed LCTR drops that deal from the live total. The filing stays
byte for byte unchanged. A prepared filing shows "A deal in this
report was later marked booking error. Check the report before you
file it." A filed filing shows "A deal in this report was later
marked booking error. Check if the filed report needs a correction."
Each booking-error deal is its own flag row, with who set it and when. The sentence follows the filing's current status. Neither sentence is on
a receipt. The left-out line still shows when dropping that deal
leaves no cluster. A sealed filing is not removed.

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
`SANCTIONS-STOP`. No sanctions list is loaded, so the screen does not
fire it. The desk says screening is not connected.

Foreign-exchange ticket, s.36(i) and s.1(2). At the foreign-exchange
line the record needs the customer's name, address, occupation, and
date of birth, as well as the identity document. An expired document
still blocks the deal. That is a product choice. Section 155 is looser.

Beneficiary, s.36(c.1) to (f). At the remittance line the ledger
stores the beneficiary's name and address. Under the line they are
stored when the teller typed them, and they may be omitted.

## Shop-day groups read (CD-107 A1)

`GET /api/ledger/lctr-groups?day=YYYY-MM-DD` is a server-only read.
`LctrGroupsService.forDay(actor, day)` checks `filing:view`: supervisor,
branch manager, administrator and compliance officer may read; teller and
auditor may not. The route checks the session and `filing:view` before query
validation: missing sessions receive 401 and disallowed roles 403, even with
a missing or malformed day. The service retains its transactional principal
check. The session supplies the tenant and entity. Query fields
other than `day` are refused, including entity, branch, axis and limit.
A foreign workspace cannot select another shop. Authorization, entity-zone
resolution, the current trigger and the receipts share one held Postgres
client and repeatable-read snapshot.

The required day is an exact real Gregorian calendar date, years 0001 through
9999; blanks, timestamps, invalid leap days and duplicate values are 400
`INVALID_REQUEST`. `entityReportZone` supplies the zone and its provenance.
The interval is start-inclusive and end-exclusive, from the start of D to
the start of D+1 in that zone, not 24 elapsed hours. Toronto's spring day is
23 hours and its autumn day 25. At a midnight overlap the first occurrence
starts the day; at a gap the first instant after the gap does. A completely
skipped local date is refused. UTC boundary strings and numeric offset
strings (`+00:00`, `-04:00`, etc.; historical seconds when present) are read
metadata only. The final day 9999-12-31 has an extended ISO year in its end.

Boundary resolution uses the runtime's IANA data through `Intl`: sampled
UTC offsets within 36 hours of midnight supply the possible exact instants.
If midnight is missing, those offset candidates bracket the local forward
gap; millisecond bisection finds the transition itself. This also handles
the Toronto/Nassau 1919-03-30/31 jump from 23:30 to 00:30 (04:30Z), rather
than assigning the first half hour of March 31 to March 30. The algorithm
assumes the bracket contains the one offset transition responsible for that
gap; it is not a general solver for arbitrary custom clock histories.
Results depend on the runtime timezone database. Focused regressions cover
that historical gap, Sao Paulo midnight, Havana overlap, Apia's skipped
date, modern 23/25-hour days, endpoint inclusion and civil range/validity.
They are not an exhaustive guarantee for every historical or future zone.

The response is `{ day, zone, zoneSource, mixed, window: { start, end,
startOffset, endOffset }, trigger, groups }`. Each group has `{ axis, key,
total, transactionIds, branchIds, needsReport }`. Money is an exact decimal
string with two places. ID arrays are sorted and duplicate-free. The
conductor key is the customer ID; on-behalf-of and beneficiary keys retain
the existing SQL `lower(btrim(name))`. No additional names are returned.
Groups are separate by axis and key; they must not be added across axes or
counted directly as deduplicated filings.

`cashReceivedGroups` shares the single-key `cashReceived` SQL amount,
entity/window predicates and joins, and the same `countsTowardLctr` reversal
rule. Both deduplicate transactions. Recorded `cash_in_home` wins; a missing
figure falls back to input only for a home-currency exchange. Non-positive
cash, cheque clearing/return, a booking-error reversal and an unvalued
foreign receipt do not contribute. All branches and all receipts are read,
with no pagination. Empty names create no name-axis group.

The isolated `shopDayLargeCashRule` reader evaluates only a latest stored
`large_cash` rule with a positive trigger, `aggregate_all_amounts: true`,
`cash_only: true`, `direction: in`, `comparator: gte`, `window_kind: fixed_24h`,
and `trigger_currency` matching the book currency resolved by `resolvePack`.
An explicit `threshold_currency` must also match the book; null or blank
uses the already-validated trigger currency, without conversion. Compatibility follows
these actual fields, not a country name. Only within that supported subset
does the lower positive desk `report_threshold` tighten the pack trigger,
using the existing precedence. The comparison is inclusive. Each group's
`needsReport` is evaluated only when its axis is explicitly listed in
`aggregation_axes`; absent axes mean unknown, with no all-axis fallback.

Unsupported or missing rules yield **`trigger: null` and `needsReport: null`**;
unlisted axes on a compatible rule also have `needsReport: null`. Groups
remain available. A desk override cannot supply missing semantics, a
currency conversion, payout coverage or another country's reporting rule.
Unknown never means false or "no report needed". In particular, current
CA-v1, US, Australia, Serbia, India, Philippines and international/no-pack
rules do not satisfy this comparison contract. `largeCashRule`,
`countryIdentification` and `cashReceived` retain their existing behavior.
An empty receipt set is `groups: []`.

The ticket requires a calendar-day read, but the stored CA-v2 report row
still says `window_kind: fixed_24h`; a DST calendar day can be 23 or 25 hours.
That mismatch remains explicit for CTO/Compliance confirmation before
broader reporting/filing integration or storing filing offsets. This
read's defensive null contract does not resolve that policy question and
does not change the pack, migrations, existing rolling gate or rules.

This is a grouping/read contract, not a change to the rolling identification
gate or an interpretation that replaces other countries' reporting windows.
The browser's existing clusters, `staticWindow`, filing totals and sealed
records are unchanged. Filing offset storage, amount/deal-set recomputation
and refusal, corrections, shared name-key alignment, VC block and the bell,
dashboard and worksheet remain later work. **CD-107/#595 stays P0 and open.**
A1 supplies only part of acceptance 1/2, not filing acceptance or a release.
No promotion until the full approved stack is complete.

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
- A stored start time (`settings.aggWindowStart`) is not applied
  and is not rewritten. The desk and the identity gate share
  `shared/rolling-24h.js`. Both look back the rolling 24 hours
  from the deal, in elapsed time. The desk reads a civil date and
  a time on the branch clock (`branches.timezone`, America/Toronto
  when the branch has none). The gate reads the deal instant.
  A receipt exactly 24 hours earlier counts. One millisecond
  earlier does not.
- Other fields s.36 asks for on a ticket (telephone, the rate, an
  account number) are not stored. The four fields the survey named
  are the ones this pack requires.
- Section 84 also requires identity when a large virtual currency
  report is required. The counter cannot book that instrument, so
  the gate cannot see one.
- A receipt under the line that was posted before the window filled
  is not refused after the fact. The next receipt in the window is.
