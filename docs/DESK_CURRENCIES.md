# The Currencies a Desk Deals In

The rule this document exists to state: **which currencies a desk trades is
data, and minor units are ISO 4217.** Neither is a literal in the code, and
they are two different questions that were both being answered the same
wrong way.

## What it cost

The ledger capped every desk in the product at four currencies. Not by
schema — `ledger_till_balances.currency` has always been a `char(3)`, the
journal is currency-agnostic, and the jurisdiction packs ship six home
currencies — but by copies of the same literal:

| where | what |
|---|---|
| `ledger/routes.ts` × 5 | `z.enum(["CAD", "USD", "EUR", "GBP"])` on `from`, `to` and three `currency` fields |
| `quotes/routes.ts` `createBody` | the same four-way enum, left behind after the ledger door dropped it |
| `ledger/routes.ts` × 4 | four-key `.strict()` records for till counts, opening balances, vault balances, unit costs |
| `ledger/service.ts`, `quotes/service.ts`, `till-control.ts`, `vault-control.ts` | `type Currency = "CAD" \| "USD" \| "EUR" \| "GBP"` |
| `os-src/cdos-os.jsx` | `const LEDGER_CCYS = ['CAD','USD','EUR','GBP']` |

A placeholder from the pilot that became a product boundary. The bill for it
is specific: remittance is the biggest thing most currency desks do, the
corridors this product seeds are the Philippines, India, China, Mexico and
the UAE, and **a Toronto desk running the Philippine corridor could not put
a peso in a till.** The request was rejected by Zod before any ledger code
ran. The browser, holding its own copy, refused first and blamed the server:
*"PHP is not carried by the server ledger yet."*

The count schema was the worst of them. Once a desk could hold a currency it
could not count, its day could never close — a close refuses to run unless
every ledger currency has a real count, so a drawer with pesos in it would
have locked the till open. **Removing a ceiling in one place and leaving it
in another is worse than leaving it everywhere.**

## The model

```
legal_entities.traded_currencies text[]     the owner's set, or NULL
server/src/ledger/currencies.ts             minor units, and the resolver
server/src/ledger/currency-control.ts       reading and changing it
GET/PUT /api/ledger/desk-currencies         the owner's screen
```

**NULL is not an empty set.** It means nobody has stated one, and the desk
may deal in anything the ledger can carry. An empty array would mean "this
desk trades nothing", which is not a state any shop is in, and the database
`CHECK` refuses it.

This distinction is the entire correctness of the change. The first version
of the resolver fell back to *the home currency alone* when a desk had
stated nothing — which is defensible on paper and replaced a four-currency
ceiling with a **one**-currency ceiling for every desk in the world, since
they all have this column NULL. Twenty-three tests failed and every one of
them was right to.

> A restriction nobody stated is not a restriction.

That is the same rule this codebase already follows for reporting lines —
the pack proposes, the desk decides, and where neither has spoken the
product does not invent an answer and act on it. See `DESK_THRESHOLDS.md`
and `ABSENT_FIGURES.md`.

## Where it is enforced, and where it deliberately is not

The HTTP doors check **shape only** (`currencyCode` in
`server/src/ledger/currencies.ts`: trim, uppercase, `^[A-Z]{3}$`). The
quote route uses that same schema; it does not re-impose a four-currency
list. Whether the pair is legal here, and whether this desk trades the
codes, is answered in the service (`pairAllowed`, `assertTradeable`).

`assertTradeable` is called on the paths that can bring a **new** currency
onto the book:

- posting a deal, and freezing a quote for one
- a till cash movement
- a vault receipt, and a vault run
- an opening vault position

It is **not** called when counting a drawer or closing a till. Those account
for money that is already there, and a desk that drops a currency from its
set must still be able to count out what it holds. Gating a close on the
traded set would strand real cash — the change is about what may come in,
never about disowning what is already in the building. Dropping a currency
is audited *with the amounts still sitting in the drawers named in the audit
row*, because that is the fact somebody will be looking for and it is not
derivable from the two sets alone.

## Minor units

ISO 4217, in `currencies.ts`, and **not a column** — how many decimal places
the yen has is a fact about the yen, not about a desk, and a column would be
a place for a desk to be wrong about it.

| | |
|---|---|
| 0 places | JPY, KRW, VND, CLP, ISK, XAF, XOF, … |
| 2 places | everything not named, which is most of ISO 4217 |
| 3 places | BHD, IQD, JOD, KWD, LYD, OMR, TND |

Every amount in this codebase was validated as `\d+(\.\d{1,2})?` and stored
as `numeric(24,2)`. That is right for most of the world and wrong in both
directions. `parseMoney` asks the currency: **there is no such thing as
¥1,234.56**, and a payout quoted that way is not a rounding nicety, it is a
figure a teller cannot count out. Quote terms, an override, and
booking all round a payout with `roundTo` in that same file, half up
to the currency's own places, and the spread is what is left of the
home value after both legs are rounded. An input that is not already
on that scale is refused in a sentence that names the currency.
`10000.55` yen is not a yen amount. A stored `10781.00` is, because
the column reads back two places. The rate stored on the deal stays
the quote rate at 12 places. Three-decimal rounding still keeps
three places in `roundTo`. Migration 053 stores an exchange payout
and the till movement at those places. A remittance face amount in
one of them is still accepted at two decimal places, and a third
decimal on that face is still refused.

An exchange shows the server `customerRate`, twelve places, on the
ticket and on the customer card. The card is that frozen quote.
Before the freeze, `POST /api/quotes/preview` uses `calculateQuoteTerms`
and writes nothing. 1,000.00 CAD pays 722.10 USD at
`1 CAD = 0.722103704355 USD`. 3,000.00 CAD pays 2,166.31 USD at the
same rate. A remittance still uses `os-src/effective-rate.js`.


A closed day's report shows the units that were stored. An open day
rounds each row to the currency's places and then adds those rows, so
the rows and the total agree. The count, the reconcile, and the
end-of-day drawer show whole units. The cash variance is the counted
figure minus that whole-unit expected, so 489,176 against a stored
489,175.85 yen reads expected 489,176 and balanced, and 489,177 reads
+1 over. When the stored expected is off the minor-unit grid, one grey
line under Expected reads: Rounded from 489,175.85 JPY stored from
older deals. It clears when the ledger is trued up. A figure already
on the grid, including 1,000.50 CAD, has no line. The book still stores
489,175.85. Before the scales table loads, and if that load fails, the
screen uses the ISO minor units, and a three-decimal currency still shows three.

**Three-decimal currencies are stored on an exchange.** Migration 053
changes each `numeric(24,2)` money column to unconstrained numeric, so a
stored `722.10` stays `722.10` and a dinar payout can keep its third place.
A fourth place is still refused. A remittance face stays at two places.

## What the owner sees

Settings → Compliance & jurisdiction → *Currencies this desk deals in*. Empty
means any. Naming a set is a deliberate narrowing, and the refusal a teller
then meets at the counter names that set rather than a list compiled into the
binary:

> This desk does not trade ZAR. Its currencies are CAD, PHP, USD — add ZAR in
> Settings if it should.

Owner-only, on `compliance:thresholds` — reused deliberately rather than
inventing a second permission with the same holder, which would be a second
thing to get out of step. A teller has no Settings screen, and the route
refuses them anyway; a hidden control is a courtesy, not a permission.

## Testing standard

- `server/tests/desk-currencies.postgres.test.ts` — minor units, the
  resolver, and the database constraint.
- `server/tests/peso-reaches-the-drawer.postgres.test.ts` — the claim, at
  the HTTP surface, because the HTTP surface is what used to refuse it.
  Every assertion in it fails against the old enum.
- `server/tests/quote.postgres.test.ts` — the quote door: a peso (or MXN)
  pair that the board publishes is quoted; garbage codes are still 400.
- `tests/e2e/currency-set-seam.spec.ts` — the owner's screen against the
  real ledger, per the standard in `CASH_OWNERSHIP_INVARIANTS.md`.
