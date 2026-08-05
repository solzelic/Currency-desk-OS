# Cash Ownership Invariants

The rule this document exists to state: **there is one book, and it is the
server ledger.** The desk renders cash; it does not compute it.

This was not true for most of this project's life, and the cost is worth
recording. The app was first built as a complete desk in the browser, where
cash was *derived* — `position(c, rows, baseline, receipts)` in
`os-src/cdos-base.jsx`, a pure function of an opening baseline plus events. A
server ledger was later added with a different model: cash *stored*, as a row
in `ledger_till_balances` that movements update. Both models were coherent.
Neither was ever declared authoritative over the other, and every cash defect
found since has lived exactly where the two met:

- a day close computed its currency set from the derived model and sent it to
  the stored one, writing `0.00` over three real currency balances;
- a posted exchange moved the stored balance while the drawer went on showing
  the derived figure from before the trade;
- the vault existed in the derived model and not in the stored one at all, so
  a drawer could be floated from a strong room with no money in it;
- the browser invented branch and till identifiers (`b01`, `b01t1`) because it
  had never needed real ones, so the ledger could not be told which till a
  request was about.

None of these crashed. Two books do not crash — they disagree, quietly, and
the daily close overwrites the evidence that they did.

## The invariants

- **PostgreSQL holds every cash figure.** `ledger_till_balances` and
  `ledger_vault_balances` are the only record of what the desk physically
  holds. No cash figure is stored in the browser, in `localStorage`, or in any
  client-side store.

- **The client never computes cash.** It may render a figure the server sent,
  convert it for display, and total it for presentation. It may not derive a
  holding from transactions, and it may not reconcile two sources — if it can
  see two figures for the same money, one of them should not exist.

- **Every movement of money is a server call that returns the new state.** A
  movement that succeeded on the server and failed to reach the browser is a
  display bug. A movement that succeeded in the browser and never reached the
  server is a loss. The client applies nothing optimistically.

- **A movement with two ends is one transaction.** A float debits a vault and
  credits a till in a single database transaction, or neither happens. The
  same holds for a vault run between branches. Half a movement is never
  written, and never rendered.

- **Balances are never invented for an unstated position.** A branch that has
  not declared its vault opening position is reported as untracked, not as
  zero. Zero is a claim about somebody's cash; only they can make it.

- **The physical count is the only external truth, and it is recorded, not
  assumed.** A close writes counted figures back as balances. It therefore
  refuses to run unless every ledger currency has a real count — a substituted
  figure at that moment overwrites real money.

- **There is no offline mode.** This is a deliberate product decision, not an
  oversight. A desk that cannot reach the ledger cannot post; it says so and
  records nothing. If offline is ever wanted it must be built as an explicit
  queue-and-replay against this same single book, never as a second book that
  is reconciled afterwards.

## Testing standard

Each side of this boundary was already well tested on its own, and that is
precisely why the defects above survived: the server suite tested the ledger,
the end-to-end suite walked the customer journey, and nothing tested the join.

**Every change that moves money carries a seam test** — one that drives the
real screen against the real ledger and asserts the two agree afterwards. A
server test and a client test are not a substitute; the failures live between
them.

## Known scope limits

These are current boundaries of the single book, not exceptions to it. Each is
tracked work, and each is stated on screen where a user could otherwise assume
coverage:

- The ledger carries a subset of the currencies the desk trades. Amounts in
  the others are shown as untracked, never silently merged with ledger figures.
- Only currency exchange posts today. Cheque cashing, pay out, money orders,
  bill payment and remittance move drawer cash without reaching the ledger.
- Branch and till identifiers are still not reconciled between the desk and the
  server. Any till in the signed-in branch can now be addressed — the switcher
  names the ledger's tills and moves the workspace the server answers for, so
  the drawer on screen and the drawer being written to are the same one — but
  a session cannot reach another BRANCH's tills, because a workspace is
  resolved from the user's home branch rather than from the branches they are
  authorized on. An owner with two locations must have somebody at each.
- The ledger carries cost — a per-location average, the lots behind it, and
  every event that moved it, under weighted average or FIFO as the desk
  chooses (see COST_BASIS.md). The screens now read it: the Vault's
  average-cost column, its unrealized P&L and the Dashboard's earnings all
  come from `GET /api/ledger/position` and `GET /api/ledger/summary`. Where a
  basis was never recorded there is none to show, and the screen says so
  rather than inventing one — see ABSENT_FIGURES.md.
- The Till's "expected" figure in the standalone (no-server) mode still calls
  `window.CDOS.holdings`, which no longer derives anything and answers null.
  A desk that cannot reach the ledger has no expected float and that screen
  should say so — `os-src/cdos-till.jsx:485`.

## Where the figures come from

There is one book, and these are the reads against it. Nothing on a screen
may compute a cash figure for itself:

| question | route |
|---|---|
| what is in this drawer | `GET /api/ledger/till-balances` |
| what is in this safe | `GET /api/ledger/vault` |
| what does this branch hold, and what did it cost | `GET /api/ledger/position` |
| what was posted, and what did it earn | `GET /api/ledger/summary` |
| which rules does this desk trade under | `GET /api/ledger/jurisdiction` |
| what does this desk report and identify at | `GET /api/ledger/desk-thresholds` |

What a screen does when one of those has no answer is its own rule, and it
is written down in `ABSENT_FIGURES.md`. The short version: absent, visibly —
never zero.

How a jurisdiction's number and a desk's own number relate — which one wins,
which way "stricter" points, and what the posting gate does when neither can
answer — is written down in `DESK_THRESHOLDS.md`. The short version: the pack
proposes, the desk decides, and a desk may only ever tighten.
