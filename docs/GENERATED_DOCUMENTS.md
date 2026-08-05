# What a Generated Document May Contain

Every document this application produces — the End-of-Day Sign-Off, the
compliance pack, the client report, the transfer receipt, the sealed filing —
is built from the ledger, expressed in the desk's own currency, and dated on
the desk's own trading day. A figure the book cannot source is printed as
absent, with the reason beside it, and never as a zero.

This is the same rule as `ABSENT_FIGURES.md`, applied where it costs the most.
A screen showing a wrong number is a bug somebody reports. A **document**
showing a wrong number is signed, filed, and produced to an examiner five
years later, by which time nobody can reconstruct what it was supposed to say.

## What this cost

An exploratory pass counted all four of a desk's drawers exactly, watched the
close-out screen say *"All counted drawers balanced · Drawers off 0 · Total
variance 0"*, closed the day, and generated the sign-off sheet:

| The sheet said | The truth |
|---|---|
| "Thursday, June 18, 2026 · Day 1" | generated 2026-08-04 |
| TRANSACTIONS 10 | 1, and it was voided |
| PAY-IN VOLUME $32,700.00 | $1,000, voided |
| REVENUE (FEES + SPREAD) $222.97 | $0.00 |
| CASH ON HAND $594,049.69 | $62,450.54 |
| CAD variance −249,270.79 | 0 |
| EARNINGS BY TELLER: three named tellers | one person traded, and earned nothing |

It is headed "Registered Money Services Business" and ends with signature lines
for *Teller on duty* and *Manager / owner*. A signed daily record disagreeing
by $340,000 with the reconciliation it was generated from.

None of it was malice and none of it crashed. Each figure had a plausible
local source: a demo seed, a browser-side sum, a count read out of
`localStorage`, a spread estimated against a market mid, a hardcoded currency.

## The rules

### 1. Every figure comes from the ledger

Not from the browser's copy of the ledger, and not from a derived store beside
it. `docs/CASH_OWNERSHIP_INVARIANTS.md` has the table of reads; a document
needing something none of them answers gets a **read endpoint**, not a loop in
the browser.

"Earnings by teller" was the example. It was summed in the browser over the
last hundred transactions it happened to be holding, with the margin
re-estimated against a live mid, and it named three tellers on a day one person
had traded once. It is now `byActor` on `GET /api/ledger/summary`: a `GROUP BY`
over the same rows the totals cover, with the same reversal exclusion, and the
same null discipline.

### 2. A document compares like with like

The sign-off's cash table put the branch's whole position — drawer **plus**
strong room — in a column headed "On the ledger", and subtracted a count of the
drawer from it. Both figures were the ledger's. Both were correct. Their
difference was −249,270.79 and meant nothing at all.

Name the box. `position().currencies[].till` is the drawer, `.vault` is the
safe, and the safe is shown for information and never netted into a variance.

### 3. A count is the ledger's record of a count

The "Counted" column read `localStorage.cdos_till_history_v2`, which the Cash
Drawer seeded on first open with a year of invented daily counts. A count that
exists only on one machine is not a count; `ledger_till_counts` is, reachable
as `latestCounts` on `GET /api/ledger/till-session`, carrying what was counted,
what was expected **at that moment**, and the variance the server computed
between them.

That last part matters. Recomputing the variance against today's balance folds
in every movement since the count — a different number wearing the same name.

### 4. The currency is the desk's, and it is stated

There is no default currency. Home currency is a fact about the legal entity,
carried on its jurisdiction pack, and reachable as
`GET /api/ledger/jurisdiction` → `pack.homeCurrency` (or
`window.CDOS.reportingLimit(settings).currency` in the browser).

A conversion has a real limit and it must be respected rather than papered
over: the browser's rate board is quoted in **units per Canadian dollar**, so
it can only produce a home valuation for a desk whose books are kept in
Canadian dollars. Everywhere else the figure is absent. This is exactly what
`LedgerReportingService.position()` already does on the server, and for the
same reason — a rate quoted against somebody else's money is not a valuation.

Not every `'CAD'` is wrong. A CAD **drawer** is a CAD drawer in Dubai. The
literal is wrong when it means *"the currency this desk keeps its books in"*,
and each occurrence has to be read to tell which it is. A find-and-replace here
would be worse than leaving it alone.

### 5. The regulator, the form and the portal belong to the pack

`jurisdiction_packs` carries `regulator`, `reportName` and the jurisdiction's
`name`. `jurisdiction_reports` carries each form's `code`, `name`,
`aggregation_hours` and `filing_format` — the regulator's own words for how a
completed report is submitted, "FWR JSON batch" or "goAML" or "BSA E-Filing
XML". Both are served by `GET /api/ledger/jurisdiction`.

**`getRegime(settings)` is not the first source.** It is the browser's own
two-country table and it falls back to FINTRAC when `settings.regime` is unset,
which is how a London desk came to print *"Prepared for FINTRAC record-keeping
under the PCMLTFA"* on a compliance pack. The server's pack wins; the regime
engine is a fallback for a desk that has not reached the server yet.

Where neither can say, **name nobody**. "This desk's regulator is not stated on
its jurisdiction pack" is a true sentence somebody can act on. A guessed
regulator on a compliance document is not a smaller error than a missing one —
it is a larger one, for the same reason migration `012_jurisdiction_reports.sql`
seeds every pack's field list EMPTY:

> Field lists are seeded empty here and transcribed per form — an empty list is
> honestly "not transcribed yet", where a guessed one would be a form that
> looks official and is wrong.

### 6. The date is the trading day

`window.CDOS.businessDate()` — the till session's `business_date`, which the
server decides — not `wallClock()` and never the `TODAY` snapshot taken when
the page loaded. A session opened before midnight is still on yesterday's
trading day at 00:05, and that is the correct answer.

A document's date, a movement reference minted from a date, and the window a
"today" figure covers are all the business date. The wall clock is for "posted
at 14:32", for greeting somebody good morning, and for asking whether an ID has
expired.

### 7. Nothing is manufactured

This one is not about accuracy. Three things were found in the browser that
fabricated records of events that had not happened:

- `seedFakeHistory()` in `cdos-reports.jsx` wrote four **sealed compliance
  filings** into the report history on module load — an LCTR for "Brooke
  Lawson" with acknowledgement number FIN-4471, an EFTR for "Jakob Miller" with
  FIN-6093 — each a full print-ready document stamped ● SEALED and footed
  *"Immutable record retained under the PCMLTFA."*
- `seedDemo()` in `cdos-kyc.jsx` fabricated eleven completed identity
  verifications against named people, each with a provider reference and all
  checks passed, and edited two real client records to make the demo read
  better.
- `fileRow()` in `cdos-ledger.jsx` marked a transaction filed with a reference
  minted by `Math.random()`.

All three are gone. A fabricated business figure is a bug; a fabricated
regulatory filing with an invented receipt number is a different category of
thing, and it does not belong in a shipped product at any stage of its life.

If a populated history is ever wanted for a sales demo it belongs behind an
explicit demo-tenant flag on the server, generated from that tenant's own
ledger — never compiled into the browser, where the only thing separating it
from a real record is a key in `localStorage`.

## Testing it

A document is generated in a popup window, which is exactly where a browser
test stops looking, and its figures come from three or four different reads,
which is exactly where a server test stops looking. So it is tested at the
seam: `tests/e2e/document-seam.spec.ts` opens a till, posts a real deal, closes
the day counting exactly, generates the sign-off sheet in a real browser, and
asserts every figure on it equals what the ledger answers — and that a day with
nothing posted produces a sheet that says so rather than one with invented
totals.

The assertion that matters most is the negative one. A day that balanced
exactly must not produce a sheet with a variance on it, and a desk that has
generated nothing must not have a compliance history.
