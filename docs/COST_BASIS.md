# Cost Basis and Realized P&L

What a currency desk earns is the difference between what it paid for a
currency and what it sold it for. Nothing else is profit, and nothing else
should be booked as profit.

## What was there before

The posting journal valued both sides of an exchange at the **market mid at
the moment of the trade**, and credited the gap between that mid and the
customer's rate to `revenue:fx_spread`:

    till:<from>        debit   input × mid
    till:CAD           debit   fee
    till:<to>          credit  output × mid
    revenue:fx_spread  credit  spread          ← the estimate
    revenue:fee        credit  fee

Two things are wrong with it. Inventory is carried at market rather than at
what it cost, so the balance sheet moves with the market whether or not
anything happened. And the revenue line is a *spread against a reference
price*, not a margin against a purchase — the desk books a gain the instant
it trades, even if it bought that currency yesterday for more than it just
sold it for. A desk running that way cannot answer "did we make money on
US dollars this month," which is the question the whole business turns on.

The browser computed a real weighted-average cost in `position()` and used it
for the Vault's P&L tab, but nothing on the server ever saw it, and the
server is the book.

## The model

**Cost per location, per currency, in the desk's home currency, per unit.**
Cost is carried per *location* — a till and a vault each carry their own —
because a float is a movement of specific cash.

How a disposal is *priced* out of that cost is the desk's choice, between
two methods that are both standard for fungible inventory under IFRS and
ASPE:

| method | a sale is costed at |
|---|---|
| `weighted_average` | the box's running average, blended over every purchase |
| `fifo` | what the oldest cash still in the box actually cost |

They report different profit on identical trades in the short run and the
same profit over the life of the stock. See **Choosing the method** below.

The cash that leaves the safe carries what the safe paid for it.

### Acquisition — no profit is booked

A currency arrives, and what it cost is what was actually given up for it:

| how it arrives | unit cost |
|---|---|
| customer sells us foreign | home currency paid out ÷ units received |
| wholesale delivery | the invoice ÷ units delivered |
| float from the vault | the vault's average cost |
| return from a till | the till's average cost |
| run from another branch | the sending vault's average cost |

The receiving average re-weights:

    new_avg = (qty × avg + units_in × unit_cost) ÷ (qty + units_in)

Every acquisition also opens a **lot** in `ledger_cost_lots`: how much
arrived, what a unit of it cost, when, and the cost event that created it.
Lots are opened under BOTH methods, always — see **Choosing the method**.

### Disposal — this is where profit is realized

    proceeds  = home currency actually received
    cost      = units_out × unit_cost
    realized  = proceeds − cost

Under weighted average, `unit_cost` is the box's running average and the
average does not change. Under FIFO, the disposal walks the open lots
oldest first and the cost is the sum of (quantity taken × that lot's unit
cost); each take is written to `ledger_cost_lot_consumption`, so a FIFO
cost of sale can be read back line by line. The lots are drawn down under
both methods, so a disposal never takes units a lot does not know about.

That is the number the desk earned, and it is the difference between the rate
it bought at and the rate it sold at, which is what a dealer means by margin.

The journal becomes:

    till:CAD             debit   proceeds
    till:<sold>          credit  units × avg_cost      ← at cost, not at market
    revenue:fx_trading   credit  realized              ← or debit, on a loss
    revenue:fee          credit  fee

A loss is a debit. A desk that sold below its cost booked a loss, and the book
says so.

### The home currency

The home currency's cost is 1 by definition. It is the unit everything else is
measured in, so it never carries an average and never realizes a gain.

## Every basis can be explained

Each change to an average writes an append-only row: what happened, the
quantity in or out, the unit cost applied, the average before and after, and
which method priced it. An average nobody can explain is not a cost basis, it
is a number. This is also what makes a reversal possible — reversing a
disposal restores the units at the cost they left at and unwinds the realized
amount, which cannot be done from a balance alone.

Under FIFO "the cost they left at" is not one number: the sale drew from
particular lots at particular prices, so a reversal puts each quantity back
in the lot it came from, using the consumption rows. A consumption row is
marked with the reversal that restored it and is never restored twice.

## Choosing the method

Which method a desk uses is the desk's decision, not its country's. Both are
permitted; they differ only in when profit is recognized, and over the life
of the stock they agree.

    jurisdiction_packs.default_cost_method   what a country's pack SUGGESTS
    legal_entities.cost_method               what this desk actually uses

`legal_entities.cost_method` is nullable, and NULL means "follow the pack" —
which is where a desk starts and stays until an owner decides otherwise. The
override is what makes this the owner's choice: a desk in any jurisdiction can
run FIFO whether its pack proposes it or not. Every pack shipped today
suggests weighted average, deliberately, so installing this restates nobody's
books.

Changing it takes the `accounting:cost_method` permission — owner or manager
— and writes `ledger_audit_events`. It changes what the desk reports as
profit, so who changed it and when is not optional.

Nothing already posted is restated when the setting moves. What changes is how
the NEXT disposal is priced.

### Why lots exist under both methods

A desk that kept lots only while FIFO was switched on would, on turning it on
after a year of trading, have no acquisitions to compute from — the software
would have to invent a history or refuse. So a lot is opened on every arrival
and drawn down on every disposal regardless of the setting. It costs one row
per purchase and it means the switch is honest whenever it is flipped, in
either direction.

Under FIFO the running `avg_cost` column is still maintained, recomputed from
the lots that remain. It is *informational* — the Vault's position screen
shows it — and a FIFO disposal is never priced against it.

### Known gaps at the FIFO boundary

Two callers still price against the average themselves rather than taking the
figure `dispose()` computed. Under weighted average the two agree exactly, so
neither is visible today; under FIFO they are the difference between the cost
events and the journal.

**The journal on a customer sale.** `service.ts` computes `costOfSale` and
`realized` from `basis.avgCost` and writes the journal, `ledger_transactions.
realized_pnl_home` and `cost_of_sale_home` from them, before calling
`dispose()`. So under FIFO `ledger_cost_events` carries the FIFO figure and
the journal carries the weighted-average one. The fix is for `service.ts` to
post the journal from what `dispose()` returned.

**Transfers between the desk's own boxes.**
A float, a return and an armoured run dispose from one box and acquire into
another. Under FIFO the disposing side now leaves at what its oldest lots
cost, but `vault-control.ts` still acquires into the receiving box at the
*sending box's average*. Under weighted average those are the same number and
nothing is wrong; under FIFO they are not, and the book value of inventory
moves as cash crosses between two of the desk's own boxes. `dispose()` returns
the unit cost the units actually left at — the receiving leg should carry that
figure.

## An opening position that nobody costed

A desk going live states what is in the drawer and the safe. It may not know
what that cash cost — it may predate the system entirely. Where a cost is
given it is used. Where it is not, the current board mid is applied **and the
event is recorded as estimated**, so any basis that still contains an
assumption can be found and corrected rather than quietly passing as fact.

## Scope

Realized P&L is recognized at disposal. Holding a currency that moves in value
produces *unrealized* P&L, which is market value minus cost basis — a
reported figure, not a journal entry, because nothing has happened yet.
