# Cheque Cashing

Cashing a cheque is not a sale. The desk hands a customer cash today
against a promise that somebody else's bank will pay it in a few days.
That is credit, and the book has to say so — otherwise the desk cannot
answer the only question this product line raises, which is *how much of
our cash is out of the door on paper that has not cleared.*

This is the first of five deal lines to come onto the ledger. Cheque
cashing, pay out, money orders, bill payment and remittance all moved
drawer cash in the browser and never reached the server; the shape set
out here is meant to be the pattern the rest follow.

## The three events

Face 1,000. Fee 35. The customer walks out with 965.

### At the counter — the cash goes out

    asset:cheques_held    debit    1000.00     the receivable
    till:<home>           credit    965.00     cash out of the drawer
    revenue:cheque_fee    credit     35.00

It balances because **face = net + fee**, and that is not an argument
anybody has to trust: `ledger_cheques` carries a CHECK constraint saying
so, and the service refuses to write a cheque whose three figures do not
add up.

Two things follow immediately.

**The drawer falls by the NET, not the face.** The fee never left the
till — it was simply never handed over. A journal debiting the till by
1,000 and crediting a fee back would balance and be wrong: it would say
the desk handled 1,035 of cash at a counter where 965 changed hands.

**The drawer must have it.** Cashing takes cash out, so it is refused
when the till cannot fund it, with the same guard an exchange gets —
`INSUFFICIENT_TILL_LIQUIDITY`, read under `FOR UPDATE` and enforced again
by the balance row's own `>= 0` predicate. A refused cashing writes
nothing: no transaction, no receivable, no cheque record. A cheque record
surviving a refused cashing would put the desk's "cash at risk" figure
above the cash it has ever held.

### When it clears — the bank pays

    asset:bank_clearing   debit    1000.00
    asset:cheques_held    credit   1000.00

**No till movement.** The funds arrive at the bank; they do not walk back
into the drawer. The cash the desk fronted left days ago. A clearance
that credited the till would put the same money in the drawer twice.

### When it is returned — NSF, or fraud

    expense:cheque_losses debit    1000.00
    asset:cheques_held    credit   1000.00

The desk is out the face amount.

**The fee is not reversed, and a future reader will wonder why.** The
desk examined the paper, took the risk, handed over the cash, and now has
to chase it — that is the work the fee paid for, and keeping it is
ordinary practice across the industry. It is also what the counter's own
journal already said happened: `revenue:cheque_fee` was credited when the
customer walked out and nothing about a cheque bouncing contradicts that.
A desk that wants to refund a fee as a gesture does it as a deliberate,
recorded act, not as a silent side effect.

The arithmetic works out the way it should. The desk paid out 965 and
kept 35; the expense is the full 1,000 against a receivable of 1,000, and
the net effect on profit is −1,000 + 35 = −965, which is exactly the cash
that left and did not come back.

### And a fourth event, which is none of the above — reversal

A cashing done in error — wrong amount, wrong customer, wrong cheque,
keyed twice — is undone rather than settled:

    till:<home>           debit     965.00     the cash comes back
    revenue:cheque_fee    debit      35.00     and so does the fee
    asset:cheques_held    credit   1000.00

**A reversal is not an NSF and they must never share a path**, however
much both feel like "the cheque didn't work out". On a return the money
is genuinely gone and the desk keeps its fee. On a reversal nothing
happened at all, so the cash goes back in the drawer and the fee goes
with it — the desk did not perform a service it can charge for.

A book that ran both through one path would do one of two things, and
both are expensive: refund the fee on every bounced cheque, so the desk
quietly loses its income on exactly the deals that cost it money; or fail
to refund it on a mis-key, so a customer is charged for a transaction
that did not happen.

The reversal is written the way every other reversal on this ledger is —
`ledger_reversals` against the cashing transaction, with the journal
mirrored from what was actually posted rather than composed a second
time. That is what makes the fee come back *without anybody having to
remember that it should*.

That write happens on `POST /api/ledger/cheques/:chequeId/reversal`.
The deal reversal route, `POST /api/ledger/transactions/:transactionId/reversal`,
refuses `cheque_cashing`, `cheque_clearing`, and `cheque_return`
(`REVERSAL_NOT_ALLOWED`). The message names the cheque reversal route.
The deal route mirrors the journal and the till and inserts
`ledger_reversals`, and it does not update `ledger_cheques` or append
a cheque event. Once it has reversed a cashing, the cheque route
answers `REVERSAL_ALREADY_EXISTS` and the cheque stays `held`.

Only a cheque the desk is still carrying can be cleared, returned or
reversed. A cheque that has already cleared cannot be reversed: the bank
has paid, and unwinding the cashing now would take cash into the drawer
against a receivable that no longer exists. That is a bank reconciliation
problem, not something a button should attempt.

## There is no cost event. Anywhere.

Every other posting path on this ledger books a cost basis, so somebody
will eventually notice the omission here and fix it. It is not an
omission.

The cash the desk pays out is its **home currency**, whose cost is 1 by
definition — it is the unit everything else is measured in
(COST_BASIS.md, *The home currency*). There is no average to move, no lot
to draw down, and no margin to realize on that leg. `avg_cost` is not
touched, `ledger_cost_events` gets nothing, and `realized_pnl_home` and
`cost_of_sale_home` stay null on the transaction row.

The fee is fee revenue, not a margin against a purchase. An NSF is an
expense, not a loss on inventory. Neither is a disposal of anything.

## Scope: home currency only

A cheque written in another currency is an **exchange as well as a
cheque**: the desk is buying US dollars at some rate while also fronting
cash against them. That deal belongs on the quote path, where the rate is
frozen, the board publication is recorded and the arriving inventory gets
a cost.

So the server refuses one, by name — `CHEQUE_CURRENCY_NOT_HOME`, with a
message that says which currency the book is kept in and where the deal
should go instead. The alternative is not "let it through": it is posting
a thousand-dollar American cheque at an implied rate of one and handing
the customer a thousand Canadian dollars.

The capture screen offers no currency field and never has, so nothing
regresses. The refusal exists for the day somebody adds one.

## One cashing per piece of paper

The cashing form keeps **one idempotency key for as long as that form
is open**. A retry and a second tap send the same key, the way a money
order and a transfer already do. The key used to be built from the
clock, so two taps were two keys: cheque 1002841 (face 40.00, fee 1.00)
was paid twice and 78.00 left the drawer.

The key is not the whole guard. A second form, or a second till, can
still mint a new key. The server then refuses a second **live** cheque
at the same branch with the same number and payer, and the same bank
when both sides stored one. A missing bank matches either way — a blank
is not a different cheque. A different bank is different paper. The
refusal is `CHEQUE_ALREADY_HELD`: "This cheque is already cashed and
still outstanding. Nothing was paid again." A unique index on the live
row (`039_live_cheque_paper`) is what makes two concurrent cashes of
that exact paper lose. Two that arrive together where one stored a
bank and the other left it blank can both pass that index; the read
catches them when they are not simultaneous. A cheque that has
cleared, been returned, or been reversed is not live, so the number
can be cashed again.

A book that already holds two live copies of the same cheque still
boots. The migration leaves the older copy on the book — the cash is
still out — and sets `paper_guard` false so that row is not in the
unique index. The newest held copy keeps `paper_guard` true and is
the row the index watches. Rows set aside are:

```sql
SELECT cheque_id, cheque_ref, cheque_number, maker, drawee_bank, created_at
  FROM ledger_cheques
 WHERE paper_guard = false;
```

A new cashing defaults `paper_guard` to true, so the index still
refuses a second live copy.

## Where a cheque lives

On the ledger. `cdos_cheques_v1` in the browser is a **cache** of it,
exactly as `cdos_submissions_v1` is a cache of the filed reports.

Outstanding exposure is a money question — it is the desk's own credit
risk, and it was being totalled from a store that dies with a browser
profile, that the second till cannot see, and that a "clear site data"
destroys. `ledger_cheques` carries the reference, the number, the maker,
the drawee bank, the customer, the type, the face, the fee, the net, the
hold, the dates, the status and the NSF/fraud flags;
`ledger_cheque_events` carries the timeline — who moved it, when, with
what note — and is append-only, because a clearance that was later
reversed is exactly the history somebody asks about.

Two things the desk used to work out for itself are now the server's,
because a browser got both of them wrong:

- **the reference number.** `CHQ-260618-003` was minted from the length
  of the local cheque list, so two tills cashing at the same moment both
  produced it, for different money.
- **the dates.** The received date is the till session's business date
  and the hold-until is that plus the hold the teller chose. A cheque
  taken on Friday evening at a branch keeping Friday's date is a Friday
  cheque.

**The cheque image is deliberately still local.** Images are being dealt
with separately and there is a ceiling on intake now
(`tests/e2e/id-intake-seam.spec.ts`); moving a base64 photograph into the
book in the same change that moves the money would put a megabyte of JPEG
inside a `SERIALIZABLE` money transaction. It lives in its own small
store keyed by the ledger's cheque id, so re-reading the register cannot
silently drop the scans.

## A desk is not left without a schedule

Migration 045 writes the default schedule where `cdos_cheque_schedule_v1` is missing. Missing means the key is absent, the value is null, the text is empty, the text is `[]`, or the text is not a non-empty JSON array. A schedule already stored, including 0%, is left byte for byte. Each desk that changes gets one `audit_events` row, actor `system migration`, action `cheque.schedule_backfill`, with `before` and `after`. A second run changes nothing and writes no audit row. Signup, onboarding, an admin creating a desk, the platform tenant, and the York FX seed write the same default when the desk is created, and they do not replace a schedule that is already there. A boot that fills a missing schedule writes one audit row, actor `system seed`, action `cheque.schedule_backfill`, with `before` and `after`. A boot that finds a schedule already stored writes none. A browser opens the desk as new only when `cdos_settings` is missing and there are no rows and no clients. A blank `cdos_settings` is missing. The schedule and a tour flag do not count as records. It writes the shop name and the empty cash, keeps the stored keys, and leaves the rate board in place. A desk that has rows, clients, or a saved `cdos_settings` opens as the saved desk, so those records are not replaced with empty.

## What a settlement is not

A clearance and a return each carry a journal, so each needs a
transaction row to hang it off — that is how every other journal here is
read, and giving cheque settlements a private format would be a second
journal. But they are **not deals**. Nobody stood at a counter.

`ledger_transactions.deal_kind` says which is which, and the totals and
the transaction list exclude the settlement kinds. Without that, one
cheque cashed and then cleared reads as two deals and twice its face
amount of volume — in the aggregate a reporting threshold is tested
against.

## What the transaction records about the counter

Two columns, `received_instrument` and `disbursed_instrument`, say what
physically changed hands:

| deal | received | disbursed |
|---|---|---|
| currency exchange | `cash` | `cash` |
| cheque cashing | `cheque` | `cash` |
| cheque clearing | `bank_credit` | `none` |
| cheque return | `none` | `none` |

They exist because the amount columns cannot answer the question. A
cashed cheque reads `from_currency` CAD, `input_amount` 1000.00,
`to_currency` CAD, `output_amount` 965.00 — and **not one dollar of cash
came in**. An engine reading only those would conclude the desk received
a thousand dollars in cash, which is wrong in both halves: it received a
piece of paper, and it *paid* cash.

**This is a fact, not a reporting decision.** Whether cashing a cheque
creates an obligation, and which one, is a jurisdiction question. A large
cash transaction report in Canada is about *receiving* large cash; a desk
cashing a cheque pays cash out and receives an instrument that is not
cash. What the packs carry today (`jurisdiction_reports.kind =
'large_cash'`, a threshold, an aggregation window) does not say which
instruments count as cash for that test, and inventing an answer here
would be the same mistake as transcribing a regulator's form from memory
— see the note at the foot of
`server/src/db/migrations/012_jurisdiction_reports.sql`. So the fact is
recorded, and the rule is left to the pack.

**Known gap, stated plainly:** the browser's aggregation engine
(`aggClusters` in `os-src/cdos-compliance.jsx`) still measures cash-in as
`cadIn(r)` — the `from` leg of any row — and therefore counts the full
face of a cashed cheque toward a large-cash aggregate. That was true
before this change and is still true after it; what is new is that the
row now carries `receivedInstrument`, so the engine has something true to
consult when a pack can say what "cash" means where the desk trades.

## Who can change the fee

The fee on a cashed cheque comes from `cdos_cheque_schedule_v1` in the desk's saved state when that schedule names the cheque type. The figure is the greater of the percentage of the face and the minimum, rounded half up to cents by the same integer-cent helper the screen uses. Payroll at 2% of 1,000.25 is 20.01. A float multiply prints 20.00. A face of 1,000.5 is the same 20.01. Fee %, a minimum, and a maximum accept at most 2 decimal places on save. More than that is a 400 that names the field, and the schedule is unchanged. A fee % says "That change didn't save. A fee % can have up to 2 decimals, like 2.25." The check reads the number, so 1e-7 is refused and 1e2 is 100. The Fee % field is text. Clearing it and leaving the field restores the saved percent. The table and the edit state show a stored 2.125 as 2.13, the figure booking uses, so saving another row stores 2.13 for that percent. A percent already stored with more places rounds half up to 2 when the fee is read, and the cheque still books. The cheque route books a face of 1000.5 at 2% as 20.01. A figure the helper cannot read is refused on save and at booking, by the same reader, so a schedule that saves can still be priced. An unreadable figure is not booked as 0.00. Min fee "4." tidies to 4.00, and Fee % "." restores the saved percent. The teller sees "Nothing was cashed. The fee for this cheque type can't be read. The owner or a manager can fix it in Cheques, Fee schedule." The places banner is 13px, outlines the field that broke the rule, and sets aria-invalid. The phone table's sideways scroll stays until the grouped-list change. A desk that has not saved a schedule, or whose saved value is null, blank, or an empty list, is priced from the default schedule: government 1.5% minimum 4, payroll 2% minimum 5, certified 1% minimum 5, money order 1.5% minimum 4, business 3% minimum 10, personal 3.5% minimum 10. That is the list migration 045 writes. A type that schedule does not name is 422 `CHEQUE_TYPE_UNPRICED`, "Nothing was cashed. This cheque type has no fee on the schedule. The owner or a manager can add it in Cheques, Fee schedule.", and nothing is written. The fee in the request is not the price. A schedule an owner or a manager saved at 0% still books 0.00.

Who may write the schedule is `canWriteSetting`. Today's default allows a branch manager and a compliance officer to write `cdos_cheque_schedule_v1`. The owner is always allowed, so a later saved row cannot lock them out. The table is today's default and will become owner-configurable. There is no screen for that yet, and nothing is stored. A teller, a senior teller, a trainee, and an auditor are refused. A platform row does not grant the write and does not take it away. On `PUT /api/tenant/state` a numeric version that is not the stored version is 409 before that refusal, so a stale tab is a conflict and not a 403, and it does not write `settings.cheque_fee_refused`. A version that is not a number still meets the refusal before the body is validated. The refusal sentence is "Only the owner or a manager can change cheque fees. Ask a manager to make this change." The stored schedule is not changed. A teller's document cannot replace the fee key, and a versioned save updates only when the version still matches, so a teller's copy cannot overwrite a fee the owner just saved. A save with no version that would change the fee is 409, writes nothing, and writes no refusal row. The update matches only when the stored fee text is unchanged. A save that lands writes `settings.cheque_fee_changed` with the staff id, name, role, the time, and the old and new price of each cheque type. The Fee schedule tab shows the locked sentence, with the lock at the start of the line and the line wrapped inside the window, the other figures grey, and no inputs and no Save, for a teller and for a cashier, before any Save. The phone table uses the same card, padding, Fee % column, and sideways scroll as main. Min fee shows two decimals in the field, as in 4.00. The example is the body colour, as in 30.00 CAD, and its header is $2,000.00. The owner and a manager see the editable table, and Save, the fee inputs, the Risk select, and Reload are 44px. A grouped list for the phone is a later change and is not here. The header names whoever is signed in now. A cashier who is signed in sees that locked table. A Save the server refuses keeps the typed values and shows one amber line above Save: "That change didn't save. Only the owner or a manager can change cheque fees." It does not repeat, it does not show a code, and it does not toast. A second save that meets a newer version shows "That change didn't save. Someone changed these fees. Reload to see the latest, then try again." The line stays on screen, including above the phone bar. Its text is darker than the amber token. The typed values stay until Reload, which then loads the server schedule and its version. A save the server cannot read shows "That change didn't save. Try again." A save that lands shows Saved beside the button. A low-fee notice to the owner is a separate change and is not here.
