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

**Weighted average cost, per location, per currency.** Weighted average is
the standard method for fungible inventory under both IFRS and ASPE, it is
what the desk already assumed, and it does not require tracking individual
notes. Cost is carried in the desk's home currency, per unit.

Cost is held per *location* — a till and a vault each carry their own average
— because a float is a movement of specific cash, and the cash that leaves
the safe carries what the safe paid for it.

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

### Disposal — this is where profit is realized

    proceeds  = home currency actually received
    cost      = units_out × avg_cost        (the average does NOT change)
    realized  = proceeds − cost

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
quantity in or out, the unit cost applied, and the average before and after.
An average nobody can explain is not a cost basis, it is a number. This is
also what makes a reversal possible — reversing a disposal restores the units
at the cost they left at and unwinds the realized amount, which cannot be done
from a balance alone.

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
