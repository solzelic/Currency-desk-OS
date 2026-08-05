# The Lines That Are Cash on One Side and a Promise on the Other

Four of this product's six deal types are the same animal: money crosses the
counter, and what stands on the other side of it is not currency but an
undertaking.

| line | cash | the promise |
|---|---|---|
| Remittance — Send | in | the desk owes a payout abroad |
| Remittance — Receive | out | a corridor partner owes the desk |
| Bill Payment | in | the desk owes a biller |
| Money Order | in | the desk owes whoever presents it |

None of them reached the server. The teller took six hundred dollars, an array
in `os-src/cdos-transfers.jsx` grew by one, and `ledger_till_balances` never
heard about it — so a shop that did twenty remittances closed the day with a
till that disagreed with its own book by whatever it had taken in, and the
compliance aggregate could not see half the cash. Nothing crashed. Two books
never do; see `CASH_OWNERSHIP_INVARIANTS.md`.

This document is the accounting. `server/src/ledger/obligations.ts` is the
implementation, `server/src/db/migrations/018_obligations.sql` is the schema,
and `server/tests/obligations.postgres.test.ts` is the proof.

---

## The one decision everything else follows from

**No margin is recognized when the deal is struck.**

A remittance desk earns in the rate as well as the fee. It sells pesos at its
own price and buys them from a corridor partner at the partner's, and the gap
is the business. But *this product does not carry the partner's price.*
`corridors[].partners[]` in `os-src/cdos-transfers.jsx` is:

```js
{ name: 'Cebuana Lhuillier', methods: ['cash', 'wallet'], etaH: 1 }
```

A name, the payout methods it supports, and how long it takes. There is no
wholesale rate, no commission schedule, no settlement price — nothing that
could be called a cost. The browser's `priceDeal()` does produce a
`marginCad`, and it is computed as *mid value in minus mid value out*: a
spread against the market mid. That is exactly `revenue:fx_spread`, which
`COST_BASIS.md` records this codebase spending a fortnight removing, for
exactly the reason it should not be reintroduced here — it books a gain the
instant a deal happens, against a reference price nobody paid, and a desk
running that way cannot answer whether it made money on the Philippines
corridor this month.

So the obligation is carried at **what was actually given up for it**: the
cash the customer handed over, or the cash the desk counted out to a
beneficiary. That is the same rule `COST_BASIS.md` applies to an acquisition
of inventory — *what it cost is what was actually given up for it* — read on
the liability side of the balance sheet instead of the asset side.

The margin appears at **settlement**, when the partner's real price is finally
known, and not one moment earlier. Until then the fee is the only thing the
desk claims to have earned, because the fee is the only thing it can prove it
earned.

### The one field the product would need

To recognize the rate margin at the counter, a corridor partner record would
need **the price at which this desk buys the payout currency from that
partner** — a wholesale rate, per corridor, per partner, effective-dated,
against which the customer's rate is a real spread. Call it
`partners[].wholesaleRate` and it would need a date, because a rate with no
date cannot price yesterday's deal.

It does not exist, in the browser or on the server, and it has not been
invented here. What settlement gives instead is the *realised* figure, which
is strictly better evidence and merely later. See `ABSENT_FIGURES.md`: absent,
visibly, never guessed.

---

## Remittance — Send

**What happens.** The customer hands over cash for a transfer and a fee. A
corridor partner pays a beneficiary abroad. The desk owes that payout.

**Worked example.** Rachel Carter sends 24,000 pesos to Maria Carter in Cebu,
paying CAD 600.00 plus a CAD 9.99 fee. Home currency is CAD.

```
till:CAD                        debit    609.99      600.00 + 9.99, in notes
liability:remittance_payable    credit   600.00      what the desk took for the promise
revenue:fee                     credit     9.99
```

**The till** goes UP by 609.99 CAD. Nothing else moves — no foreign cash is
touched, because the pesos are paid out three time zones away by somebody
else.

**The obligation** opens: `remittance_payable`, face 24,000 PHP, carrying CAD
600.00, counterparty *Cebuana Lhuillier*, corridor `PH`, status `open`.

**Not booked:** any margin. `spread_cad` on the transaction row is `0.00` and
means it.

---

## Remittance — Receive

**What happens.** A beneficiary collects a transfer sent from abroad. The desk
counts out cash and keeps its fee from the proceeds; the corridor partner owes
the desk what it fronted.

This is structurally the same shape as cheque cashing — cash out against a
receivable — and it is deliberately written to look like it. See
`CHEQUE_CASHING.md`.

**Worked example.** A PHP 16,000 transfer is collected. The desk pays CAD
400.00 in notes and retains a CAD 5.00 fee out of the funding.

```
asset:remittance_receivable     debit    405.00      what the partner owes this desk
till:CAD                        credit   400.00      counted out to the customer
revenue:fee                     credit     5.00      retained, never touched the drawer
```

**The till** goes DOWN by 400.00 CAD, and **the posting is refused outright if
the drawer has not got it** — `INSUFFICIENT_TILL_LIQUIDITY`, checked before
anything is written, exactly as an exchange refuses.

**The obligation** opens: `remittance_receivable`, face 16,000 PHP, carrying
CAD 405.00.

Note that the fee is inside the carrying amount. The desk fronted 400 and is
owed 405; if the partner remits only 400 the desk did not break even, it lost
its fee, and the book should say so.

---

## Bill Payment

**Worked example.** A customer pays a CAD 150.00 hydro bill with a CAD 2.50
service fee.

```
till:CAD                debit    152.50
liability:bill_payable  credit   150.00
revenue:fee             credit     2.50
```

**The till** goes UP by 152.50. **The obligation** opens: `bill_payable`, face
CAD 150.00, carrying CAD 150.00, counterparty *Toronto Hydro*, reference the
account number, corridor `NULL`, `cross_border` false.

Face and carrying are the same figure and the same currency, so settlement
normally produces no margin at all and writes no margin line. Where it does
produce one — a biller that discounts, an aggregator that charges — the
difference is recorded honestly rather than absorbed.

---

## Money Order

**Worked example.** A CAD 300.00 money order payable to Landlord Holdings Ltd,
fee CAD 3.99.

```
till:CAD                       debit    303.99
liability:money_order_payable  credit   300.00
revenue:fee                    credit     3.99
```

**The till** goes UP by 303.99. **The obligation** opens:
`money_order_payable`, face CAD 300.00, reference the serial, and it stays open
until the instrument is presented and paid.

---

## Settlement — where the margin finally is

One journal for all four, because the shape does not change with the line that
opened it.

**A payable settled.** The Cebuana payout above is funded for CAD 578.40:

```
liability:remittance_payable    debit    600.00      the carrying amount, off the book
asset:bank_clearing             credit   578.40      what it actually cost
revenue:remittance_margin       credit    21.60      the margin, at last
```

**And when the corridor cost more than it sold for** — funded at CAD 612.00:

```
liability:remittance_payable    debit    600.00
asset:bank_clearing             credit   612.00
revenue:remittance_margin       debit     12.00      a loss is a debit
```

**A receivable settled.** The partner remits CAD 402.00 against 405.00 owed:

```
asset:bank_clearing             debit    402.00
revenue:remittance_margin       debit      3.00      short, and the book says so
asset:remittance_receivable     credit   405.00
```

**No till moves on a settlement.** A corridor partner is funded by wire and a
biller is remitted by wire, and neither touches a drawer. `asset:bank_clearing`
is the boundary account where money leaves this book — the ledger carries no
bank balance today, and naming the account rather than leaving the other side
implied is what keeps the journal balanced and what makes it obvious, the day a
bank account *is* modelled, exactly which line becomes a real balance.

A settlement is `deal_kind = 'obligation_settlement'`, not a deal. Counting it
as one would put a single remittance in the day's volume twice — the same
distinction migration 017 draws between `cheque_cashing` and `cheque_clearing`.

`revenue:settlement_margin` is the account for bill payments and money orders;
`revenue:remittance_margin` for the two corridor lines. A reader looking for
corridor performance should not have to subtract utility rounding out of it.

---

## Three endings, and they are not interchangeable

This is the part it is easiest to get wrong, and the wrongness is invisible in
a total.

### Reverse — the deal was mis-keyed

`POST /api/ledger/obligation-deals/:transactionId/reversal`

The deal never should have existed. Cash goes back over the counter exactly as
it came, every journal line is mirrored into `ledger_reversal_entries`, the
obligation's status becomes `reversed`, and **no revenue, margin or expense
account is touched by anything other than that mirror**. A typing mistake must
not appear anywhere in the desk's corridor losses.

The reversal is refused if the drawer can no longer fund the cash going back
out (`REVERSAL_NOT_ALLOWED`) and refused once the obligation has been
discharged — a partner that has already been paid cannot be un-paid by saying
the deal never happened, and the honest move at that point is a new deal in the
other direction.

### Write off — the counterparty did not perform

`POST /api/ledger/obligations/:obligationId/write-off`

```
expense:remittance_losses       debit    405.00
asset:remittance_receivable     credit   405.00
```

Real money, really lost. **No till moves**, because nothing came back. It goes
to an expense account rather than to the margin account a settlement uses: a
corridor that defaulted is not a corridor that priced badly, and a desk reading
its margin line should not have to subtract its own bad debts out of it by hand.

**Payables cannot be written off.** A money order nobody presents does not
become the desk's money — in most jurisdictions it escheats to the state after
a stated dormancy period — and no jurisdiction pack in this ledger states one.
`OBLIGATION_NOT_WRITABLE_OFF`. What a pack would need is a **dormancy period
and an escheatment destination per instrument type**; it does not carry either,
and the discipline for that is at
`server/src/db/migrations/012_jurisdiction_reports.sql:129-132`.

### Settle — the promise was honoured

Covered above. The one thing worth restating: a settlement changes the profit
reported on a deal that already happened, off a partner statement nobody at the
counter can see. It therefore takes `transaction:reverse` — supervisor and
above — not `transaction:post`. A teller cannot restate a margin.

---

## Cost basis: none of these four is inventory

`COST_BASIS.md` says cash in or out in the desk's home currency has a unit cost
of 1 by definition, produces no cost event and no realized P&L. All four of
these lines move **home currency only** across the counter:

- a send takes home-currency cash and hands the customer a promise;
- a receive counts out home-currency cash against a promise;
- a bill payment and a money order take home-currency cash.

The foreign amounts — 24,000 PHP, 16,000 PHP — are the *face of an obligation*,
not cash in a drawer. The desk never holds them; a partner does, abroad. So no
`ledger_cost_events` row is written by any of these paths, and
`obligations.postgres.test.ts` asserts that: a cost event here would mean the
ledger believed it had bought pesos it never touched.

The service refuses to post a cash leg in anything but the pack's home
currency. **The day the product offers a remittance funded with foreign cash
over the counter, that leg IS inventory** and has to be routed through
`acquire()`/`dispose()` in `cost-basis.ts` before it is allowed. That is a
deliberate refusal rather than a silent mis-booking.

---

## What the compliance engine is now told

The engine must reason from facts, not from the shape of a row. Migration 018
widens migration 017's `deal_kind` and instrument columns and adds two more, so
every one of these deals carries:

| fact | column |
|---|---|
| what kind of deal | `deal_kind` |
| what arrived at the counter | `received_instrument` |
| what left it | `disbursed_instrument` |
| how much cash came in, in home currency | `cash_in_home` |
| how much cash went out, in home currency | `cash_out_home` |
| did the value leave the country | `cross_border` |

| line | `received` | `disbursed` | `cash_in_home` | `cash_out_home` | `cross_border` |
|---|---|---|---|---|---|
| Remittance — Send | cash | electronic_funds_transfer | principal + fee | 0.00 | true |
| Remittance — Receive | electronic_funds_transfer | cash | 0.00 | payout | true |
| Bill Payment | cash | bill_credit | bill + fee | 0.00 | false |
| Money Order | cash | money_order | face + fee | 0.00 | false |
| settlement / write-off | bank_credit or none | bank_credit or none | 0.00 | 0.00 | inherited |

**Why the cash figure cannot be inferred.** On a remittance receive,
`input_amount` is 16,000 — pesos a sender abroad dispatched — and the cash that
actually crossed the counter is CAD 400 going *out*. The browser's
`aggClusters()` in `os-src/cdos-compliance.jsx` reads `cadIn(r)` off every row
and treats a positive figure as cash received; on a receive that is a four
hundred dollar cash receipt that never happened, and on a foreign-leg row it is
a peso figure divided by whatever rate is on the board today. That is the
defect the columns above exist to close.

**Identification is not the same rule as reporting.** The posting gate asks for
identification against the cash figure in *either* direction — knowing who you
just handed four thousand dollars to is a plainly sensible obligation and is
not a rule about which way the money was walking. A **large cash report** is
about cash a desk *received*, and that rule is the engine's to apply, from
`cash_in_home`. The service does not pretend to be the report engine; it
records the facts and enforces its own two gates.

**Cross-border.** Every corridor this product ships crosses a border, and
`cross_border` is recorded as a fact rather than inferred from a payout
currency — a peso payout and a US dollar payout are both cross-border, and a
Canadian desk crediting Canadian dollars to a Canadian biller is not. An
electronic funds transfer report has its own rules for cross-border movements
and they are not the large-cash rules.

---

## Where the line between server and browser was drawn

The rule applied: **an obligation with a balance is money and belongs on the
server. A beneficiary's nickname is not.**

On the server, because it is money or because a report is built from it:

- the cash, the journal, the till movement;
- the obligation — kind, counterparty, corridor, face, carrying amount,
  status, what it settled for;
- the compliance facts above;
- the customer, and the purpose and source of funds captured at the counter.

Left in the browser, because it is a workflow record rather than a balance:

- the beneficiary book — names, relationships, pickup cities, account numbers,
  wallet ids. None of it is a figure; all of it is the teller's convenience;
- the corridor and partner catalogue, including which payout methods a partner
  supports and its ETA;
- the transfer's status lifecycle beyond the money (`created → sent → transit →
  paid`), its timeline notes and its collection PIN;
- the cheque image, for the same reason `017_cheque_cashing.sql` gives.

The transfer's ledger identity travels back into the browser record
(`serverTransactionId`, `serverObligationId`) so the two can be joined, and the
browser stores no cash figure of its own — `CASH_OWNERSHIP_INVARIANTS.md`
holds.

---

## Routes

```
POST /api/ledger/remittances/send
POST /api/ledger/remittances/receive
POST /api/ledger/bill-payments
POST /api/ledger/money-orders
GET  /api/ledger/obligations?status=open&limit=200
POST /api/ledger/obligations/:obligationId/settlement
POST /api/ledger/obligations/:obligationId/write-off
POST /api/ledger/obligation-deals/:transactionId/reversal
```

Every write takes an idempotency key, runs at SERIALIZABLE through
`withSerializationRetry`, and refuses when the till is shut. The four posting
routes take `transaction:post`; settlement, write-off and reversal take
`transaction:reverse`.

`GET /api/ledger/obligations` answers the question the browser store could
never answer: what does this desk owe, and what is it owed, right now, as one
number per side. It is scoped to the legal entity rather than the till, because
the teller who took the remittance goes home and the payout still has to be
funded. Where a side has nothing open it answers `null`, not `0.00` —
`ABSENT_FIGURES.md`.
