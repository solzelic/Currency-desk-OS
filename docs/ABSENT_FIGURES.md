# What a Screen Shows When the Ledger Has No Answer

The rule: **a figure with no server row is shown as absent, visibly. Never
as zero, never as a demo number, never as a confident-looking total.**

"—" with a short line saying why beats a bold `$594,124.00` that is fiction.

## Why this needs writing down

Every cash defect this project has had lived at the seam between the
browser's derived book and the server's stored one — see
`CASH_OWNERSHIP_INVARIANTS.md`. Closing that seam moved the *cash* onto the
ledger. It did not, by itself, decide what a screen does on the many
occasions when the ledger genuinely has nothing to say, and the answer the
code reached for by default was zero, because zero is what an empty sum
returns.

Zero is a claim. "The desk earned nothing today", "the safe holds nothing",
"these notes cost nothing", "we are flat in euros" — each of those is a
statement of fact about somebody's money, and only the book gets to make
it. A period with no transactions has no volume; it does not have a volume
of zero. A balance that predates cost tracking has no basis; it does not
have a basis of zero. The two render identically and mean opposite things.

What this cost, measured on a desk that had done exactly one $1,000 deal:

| Screen | Said | The ledger |
|---|---|---|
| Ledger header | 38 records · $130,566.36 pay-in | 1 transaction, $1,000 |
| Dashboard | Earnings $1,150 · Deals 38 · Margin 0.88% | $0 / 1 |
| Dashboard · FX exposure | EUR **SHORT** −$10,302 | **long** EUR 12,000 |
| Vault · Position | $594,124.00 on hand · Unrealized +$4,461.13 | the vault was empty |
| Close-out | Earned today $223.00 | $0 |

None of them crashed. The exposure panel is the one that costs money: an
owner hedging off it would sell euros they do not have short and buy pesos
they never held.

## The rule, applied

### The server answers `null`, not `0`

`LedgerReportingService` returns `null` for every money field it cannot
source, and the counts beside them stay real numbers:

```json
{ "posted": 0, "volumeHome": null, "feesHome": null, "realizedPnlHome": null }
```

"No deals" is something the ledger genuinely knows, so `posted` is `0`. What
those deals were worth is not, so it is `null`. That distinction is made on
the server on purpose — a client turning an empty list into `$0.00` is
exactly the bug, and it should not be possible to write it by accident.

### A total is only offered when it covers everything

Where any row in a sum has no figure, the sum is `null` and the rows that
caused it are named:

```json
{ "marketValueHome": null, "unvaluedCurrencies": ["EUR", "PHP"] }
```

A total that silently omits two of nine currencies is worse than no total,
because it looks complete. Naming the rows lets the screen say *which* line
is the reason the headline reads "—", which is the difference between an
answer and a shrug.

### Every derived figure inherits the rule

Unrealized P&L is market value minus cost basis, so it is `null` unless
**both** are known for the **whole** quantity. A margin is a ratio of two
ledger figures and is `null` unless both exist and the denominator is
positive. A percentage of a total is `null` when the total is.

Partial knowledge does not average out. Three real balances blended with six
invented ones is not "mostly right"; it is a number with no meaning that
prints in the same font as one that has.

### The screen shows a dash AND a reason

`window.CDOS.Absent` is the shared renderer:

```jsx
<Absent why="nothing posted yet today" />
<Absent why="no cost basis for USD, EUR" />
<Absent why="this vault is not on the ledger yet" />
```

The `why` is not decoration. A bare "—" reads as a rendering fault and gets
reported as one; "— nothing posted yet today" reads as an answer, and is
one. Keep it short and factual: what is missing, and what would fill it in.

The Vault's own banner — *"This vault isn't on the ledger yet · Count the
safe once and record it"* — was always the right pattern. The bug was the
nine bold unqualified figures sitting directly beneath it.

### Absent is not the same as empty, and neither is the same as broken

Three states, three renderings, and they must never collapse into one:

| State | What it means | What the screen says |
|---|---|---|
| untracked | nobody has told the ledger about this box | "not on the ledger yet" + how to fix it |
| empty | the ledger has this box and it holds nothing | "0.00", which here is a real figure |
| unreachable | the request failed | the error, and nothing else |

The third one matters most. A screen that fails to reach the ledger and
renders its last known figures anyway is the second book coming back —
quieter than before, because now nobody is even maintaining it. There is no
offline mode (`CASH_OWNERSHIP_INVARIANTS.md`); a desk that cannot reach the
book says so and shows nothing.

## A threshold nobody set

The same rule governs settings, not just money. `reportingLimit(settings)`
returns `{ amount: null }` when no reporting line can be established, and
every call site is careful about it: nothing is flagged, and the screen says
so.

Flagging *everything* would be the intuitive "safe" direction and it is the
wrong one — a compliance screen that flags every deal is a screen that gets
ignored, which is how a real reportable transaction walks past somebody. A
threshold this desk never chose is not a conservative default, it is a
different country's law applied silently.

## Testing it

An absent figure is easy to write and easy to regress into a zero, because
both compile and only one of them is wrong. So it is asserted on both sides
of the seam:

- `server/tests/ledger-reporting.postgres.test.ts` asserts `toBeNull()` on
  every money field of an empty period, on a basis nobody recorded, and on a
  currency with no published rate.
- `tests/e2e/reporting-seam.spec.ts` drives the real screens against the
  real ledger and asserts that where the book answers `null` the screen
  shows "—" with a reason — and that the demo book's fingerprints
  (`130,566`, `2026-06-18`, `594,124`) appear nowhere.

A test that only checks the happy path lets the zero back in on the first
refactor.
