# The Pack Proposes, the Desk Decides

Every compliance number in this product now exists in two places, and the
relationship between them is always the same one:

| | holds | means |
|---|---|---|
| `jurisdiction_packs.*` | the mandate | what the regulator requires |
| `legal_entities.*` | the desk's own line | what this desk actually operates at |

`NULL` on the legal entity is **not a missing value**. It means *follow the
pack*, which is where every desk starts and where it stays until somebody
deliberately decides otherwise. This is the shape
`legal_entities.cost_method` already had (see `COST_BASIS.md`), and it is
the shape every setting of this class should take.

Four lines follow it today:

| line | pack column | desk column | what "stricter" is |
|---|---|---|---|
| Reporting threshold | `report_threshold` | `report_threshold` | **lower** |
| Identification threshold | `id_threshold` | `id_threshold` | **lower** |
| Aggregation window | `aggregation_hours` | `aggregation_hours` | **longer** |
| Record retention | `retention_years` | `retention_years` | **longer** |

The window is the one that reads backwards at a glance. Summing a person's
cash over 72 hours catches sets of deals a 24-hour window lets through, so
a longer window is more diligence, not less. Getting that the wrong way
round inverts the alarm — it flags the desk running a wider net and says
nothing to the one running a narrower one.

`aggregation_hours` NULL on a pack is not a missing 24. It means that
pack has no hour window. India stores NULL and puts the calendar month
on the cash-report row. The Philippines pack stores NULL and puts the
banking day on the covered-transaction row. A reader must not fill
that NULL in as 24. A desk choice must not turn it into 24 hours. The
till does not add the banking day up.

## The rule

**A desk may tighten. A desk may never loosen.**

Those two facts are not symmetrical and nothing in this codebase may treat
them as though they were.

- **Tighter than the mandate is a decision, not a fault.** A desk sets its
  identification line at 1,000 where its regulator asks 3,000 because its
  bank or its auditor wanted to see it. Say so plainly — "stricter than
  FINTRAC requires (10,000)" — and then stop. No warning colour, no icon,
  no notification bell. Putting a deliberate choice in the bell trains an
  owner to ignore the bell, which is how the real one gets missed.
- **Looser than the mandate is a compliance failure.** That desk is not
  reporting things it is legally obliged to report. It has to be
  unmissable, on the screen where the change was made and in the bell,
  until it is back inside.
- **Following the pack is the normal case.** Name the number and where it
  came from. Say nothing else.

The resolved posture is computed once, on the server, in
`server/src/ledger/thresholds.ts`, and every line comes back labelled:

```json
{ "effective": "1000.00", "deskChoice": "1000.00",
  "packValue": "3000.00", "posture": "stricter" }
```

`following` and `matching` are different states and both are benign.
"We never thought about it" and "we looked at 10,000 and agreed with it"
diverge the moment a pack is corrected: a desk that deferred moves with the
pack, a desk that pinned the figure does not.

## Why this is not enforced in the database

It is tempting to write "you cannot be less strict than the law" as a CHECK
constraint. It is the wrong place for it. A pack is versioned and a
threshold can be corrected downward, which would instantly make every desk
sitting at the old figure unwritable — and would fail the very UPDATE
trying to fix them. The relationship between the two numbers is a **posture
the desk is told about**, not a constraint that stops a row existing. Only
the arithmetic is guarded: a negative or zero threshold is not a strict
desk, it is a broken one. That zero is the desk's override column and
the pack's single `id_threshold` column. It is not the per-deal line in
`jurisdiction_id_thresholds`, where null means "this kind of deal has
no line" and zero means "every deal". A country pack whose line is
already in the home currency still resolves the single column, and
`money()` still treats zero there as "cannot say", except `pack-gb-v2`.
That pack's gate reads the per-deal rows: £12,000 or more for an
occasional transaction, and more than £800 for a transfer of funds. A
desk number strictly below one of those amounts tightens that line. A
number at or above it does not raise it, and Settings will not save an
identification number of £12,000 or more on that pack. A reporting
figure of 0 on that pack means there is no large-cash report, not that
every deal must carry purpose and source of funds. See `docs/UK_PACK.md`.
The baseline gate reads the per-deal rows. Serbia does too, because its
lines are in euros, converted at the NBS middle rate for the Belgrade
day and not at the market snapshot: `docs/SERBIA_PACK.md`.

## What the ledger does with it

The identification line is not advice. `LedgerService.requireIdentification`
refuses to post a deal at or above it for a customer nobody has identified,
on both posting paths, **in the currency the pack states the book is kept
in**.

A desk with no country pack is not paused and is not given Canada's
line. It trades under the international baseline (`pack-intl-v1`).
The same new deals post under that pack:

- a quote
- an exchange
- a frozen quote
- a remittance being sent
- a remittance being received
- a bill payment
- a money order
- a cheque being cashed
- an owner writing a threshold override

The baseline states those identification lines in US dollars. A cash
foreign exchange is identified at 3,000 USD or more. A remittance, an
electronic transfer, and a virtual-currency deal are identified at
1,000 USD or more. Full due diligence, the purpose and source of
funds, is the large-cash line: 10,000 USD or more. The posting gate
and the numbers the till reads (`readDeskThresholds`) convert those
figures into the desk's home currency at the newest market snapshot
(CAD per 1 unit), not at a mid the shop set on its board, and round
down to the cent. The remittance identification line (1,000 USD) is
converted the same way and returned as `remittanceIdThreshold`. The
gate stores the rate and the snapshot time on the deal. If the
snapshot is missing, older than 24 hours, or has no mid for the home
currency, those lines come back unset: an unverified customer is
identified on every deal, and purpose and source of funds are
required on every deal. A line already written in the home currency
does not need a snapshot. A USD book does not either. The threshold editors stay available. The
till and Settings show: "We don't have rules for your country yet.
These are the international anti-money-laundering rules. Please check
they match your country's laws." Compliance names that pack
International baseline (FATF), names no regulator, and lists Large
cash record (CASH-RECORD), Suspicious transaction (SUSPICIOUS), and
Terrorist or sanctioned property (SANCTIONS-STOP). Each money line is a plain sentence. A desk following the
baseline reads "Following the international baseline: £8,000.00,
which is 10,000 USD at today's market rate." A stricter line names
the desk's own figure and the converted baseline separately: the
US-dollar source sits on that converted pack value, not on the
owner's lower number. A looser line names the same converted
baseline, not the raw 10,000. A missing or stale rate says
identification is required on every deal. A baseline desk is not
shown Canada, FINTRAC, or the unconverted 3,000 and 10,000. The
new-transfer form treats the typed amount as the desk's home
currency. A send adds the fee; a receive uses the payout. That cash
is compared with the remittance line and the desk's own
identification line, and the lower one binds. A desk on the Canada
pack version 1 still uses that pack's single line, in Canadian
dollars. A new Canada desk opens on version 2, which is described
in docs/CANADA_PACK.md. No line, or no fresh rate,
means identification is required.

These still post, because they are not a new deal:

- voiding an exchange already on the book
- voiding a cheque cashing
- voiding an open obligation
- clearing or returning a cheque the desk already holds
- settling or writing off an obligation already open
- a vault movement
- a till cash movement

A settlement row is stamped with the pack the original deal was
stamped with. A deal that was never stamped stays NULL. The Settings
editors stay available on a baseline desk.

It used to be this, in a code path documented as jurisdiction-neutral:

```ts
if (inputCad.gte(3000) && customer.rows[0].id_status !== "verified")
```

A hardcoded 3,000, in a variable named for one country's money. A British
desk whose pack says 1,000 cleared four deals in five that it was obliged
to identify; a UAE desk on 3,500 dirhams refused business it was entitled
to take. The variable name was the bug in miniature.

`pack-ae-v2` is the other way around. AED 3,500 or more is the
foreign-exchange identification floor, and a desk must not raise it.
A stored number at or above 3,500 is ignored. A number below 3,500
tightens. A money transfer on that pack is identified at any amount,
whatever the box says. The reporting column is 0, which means there
is no cash report. It does not mean "cannot say", and it does not
demand purpose and source of funds on every foreign exchange. See
`docs/UAE_PACK.md`.

### When nothing can state a line

`resolveIdThreshold` returns `null` where neither the desk nor its pack
states a figure — a pack that was never installed, or one authored with a
zero, which is ambiguous in the worst possible way ("identify everybody" to
one reader, "no line stated" to the next).

Null is not zero and it is not infinity. Both blanket answers are wrong: a
gate that never fires clears deals nobody checked, and a gate that always
fires stops a working shop trading. So the gate does not give a blanket
answer:

This is a pack that is installed and states no line. A desk with no
country pack does not land here: it trades under the baseline, as above.

- **A verified customer trades.** They satisfy every possible value of a
  line nobody can state. There is nothing to be unsure about, and a
  misconfigured pack does not close the shop.
- **An unverified customer is refused**, in words that name the real
  problem — that the desk has no identification threshold — rather than in
  words that read as a failure by the person at the counter. "We could not
  work out whether ID was needed, so it wasn't" is not something anybody
  can say to a regulator.

This is the same rule the browser follows for the reporting line:
`overReportingLimit` in `os-src/cdos-base.jsx` answers `null` rather than
`false`, because a screen that turns "cannot say" into "cleared" has
quietly passed a deal nobody checked. See `ABSENT_FIGURES.md`.

## Changing a line

`GET` / `PUT /api/ledger/desk-thresholds`, permission-gated on
`compliance:thresholds` and **audited** into `ledger_audit_events` as
`compliance.thresholds.change`, with the before, the after and the
resulting posture:

    identification threshold pack default (3000.00) → 1000.00 (stricter)

The audit row is not a nicety. Unlike a costing method, which an accountant
can reconstruct from the lots, a threshold leaves no trace anywhere else in
the book. The only record that a reporting line ever moved is the one
written when it moved.

`compliance:thresholds` is the **owner's alone** — narrower than
`compliance:file`, which everybody at the counter holds because the person
who took the cash is often the person who has to report it, and narrower
than `accounting:cost_method`, which a branch manager shares. Where the
reporting line sits is not a day's work at a branch; it is the standing
policy of the registered business, and the registered business is one
person. The compliance officer is the instructive refusal: they may file
every report the line creates and may not move the line that creates them.
Anybody who wants it moved asks the owner, which is a conversation worth
having out loud.

Everybody may **read** it, on `ledger:view`. Refusing the read would be the
wrong lesson from refusing the write, since everybody at the counter needs
to know when to ask for ID.

Nothing already posted is re-judged. A deal that cleared under the old line
stays cleared and a report already filed stays filed; what changes is the
next deal. Retroactively deciding that last Tuesday's deals were reportable
would create obligations nobody can discharge, against customers who have
long since walked out.

## Where the browser reads it

`reportingLimit(settings)` in `os-src/cdos-base.jsx` is the one answer to
"what is this desk's reporting line", in precedence order:

1. the desk's own line, as the **ledger** resolved it
2. the jurisdiction pack, from the server
3. the owner's saved setting, which is all the standalone build has
4. the browser's regime engine

`identificationLimit(settings)` is its twin for the ID line — the one the
ledger will actually refuse a deal at. A screen warning a teller at 3,000
while the server refuses at 1,000 is worse than either number alone,
because it teaches the teller that the warning is wrong.

`getRegime()` in `os-src/cdos-compliance.jsx` folds the server's figures
into the browser's pack, so every screen that reads a regime — LCTR, the
aggregation engine, the KYC nudge — gets the same numbers without asking
for itself. `jurisdictionPosture(settings)` returns the four lines judged
against the real pack; `jurisdictionViolations(settings)` is that list
filtered to `looser` and nothing else, which is what the notification bell
consumes.

## Testing standard

Per `CASH_OWNERSHIP_INVARIANTS.md`: every change here carries a **seam
test**. `tests/e2e/desk-thresholds-seam.spec.ts` changes the line on the
real Settings screen and then asks the ledger to post a deal on the wrong
side of it. A server test proving the gate uses the resolved number and a
browser test proving the control writes something cannot, between them,
prove they are the same number — and that is where every defect in this
project has lived.
