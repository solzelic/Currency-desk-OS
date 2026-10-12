# Transfer cancel — the contract phone PR #113 calls

Cancelling a transfer that took cash is the obligation reversal. It is not a
local status, and it is not a hand refund. Desktop (`os-src/cdos-transfers.jsx`)
already calls the helper below. Phone files under `os-src/phone/` are owned by
another branch; this document is what that branch wires.

## Helper

`os-src/cdos-transfer-cancel.js` is loaded by `CurrencyDesk OS.html` before the
transfer screens. It publishes `window.CDOS.transferCancel`.

| member | what it does |
|---|---|
| `TELLER_MESSAGE` | `Only a manager can cancel a transfer that took cash. Ask a manager to cancel.` |
| `RECEIVE_MESSAGE` | `A received transfer can't be cancelled here. Ask a manager.` |
| `PAID_OUT_MESSAGE` | `Already paid out to the customer.` |
| `HELD_MESSAGE` | `On hold. Release it first, then cancel.` |
| `PARTNER_LABEL` | `I checked with the partner: it has not been paid out` |
| `canPost(role)` | true for Owner, Manager, and Senior teller. Those OS roles already map to `transaction:reverse`. Cashier and Trainee are false. This grants nothing. |
| `review(obligation)` | `{ kind: "confirm", sentence }` or `{ kind, message }`. The sentence is built from the one obligation row `GET /api/ledger/obligation-deals/:transactionId` returned. It does not add the fee and it does not price the corridor. A receive is refused with `RECEIVE_MESSAGE`. |
| `idempotencyKey(transactionId)` | `web:transfer-cancel:<transactionId>`. Stable for the life of the deal, so a second tap replays. |
| `paidOutKey(transactionId)` | `web:transfer-paid:<transactionId>`. |
| `postCancel(transactionId, reason)` | `POST /api/ledger/obligation-deals/:transactionId/reversal` with that key, the reason (at least 3 characters), and `partnerConfirmedNotPaid: true`. Retries once on `IDEMPOTENCY_IN_PROGRESS`. Any other error is thrown. |
| `postPaidOut(transactionId)` | `POST /api/ledger/obligation-deals/:transactionId/payout`. Same retry. |

A cashier must not be offered Cancel. Show `TELLER_MESSAGE` and do not call
`postCancel`. There is no cancel-request flag on the book, and this contract
does not add an approval workflow.

## Figures

`GET /api/ledger/obligations` returns, on each row:

- `cashInHome` — cash the customer handed over, fee included. A 600.00 send with a 9.99 fee is `609.99`.
- `cashOutHome` — cash the desk counted out, on a receive.
- `faceAmount`, `faceCurrency` — the partner face the post stored.
- `counterparty` — the partner name.
- `homeCurrency`
- `paidOutAt` — set once the partner has paid the beneficiary, otherwise null.
- `status` — `open`, `settled`, `written_off`, or `reversed`.

Those fields are the stored deal. The confirm sheet reads them from
`GET /api/ledger/obligation-deals/:transactionId`, the one transaction,
not from the newest page of `GET /api/ledger/obligations`. `cashInHome`
is the till movement the reversal will undo. `faceAmount` is the partner
face the post stored on `ledger_obligations`, not a price the confirm
sheet computes. The browser does not multiply the principal by a board
rate when it draws this sheet.

Send confirm, when `cashInHome` is greater than zero:

> This gives the customer back 609.99 CAD from your drawer and cancels the 20,272.05 PHP owed to Cebuana Lhuillier.

The numbers above are the shape. The words use the row's figures, grouped to
two decimals. A receive uses `cashOutHome`:

> This puts 400.00 CAD back in your drawer and cancels the 16,000.00 PHP Cebuana Lhuillier owes this desk.

## Endpoints

```
POST /api/ledger/obligation-deals/:transactionId/reversal
{ "idempotencyKey": "web:transfer-cancel:<transactionId>", "reason": "Cancelled at the counter" }

POST /api/ledger/obligation-deals/:transactionId/payout
{ "idempotencyKey": "web:transfer-paid:<transactionId>" }
```

Reversal requires `transaction:reverse` (supervisor, branch manager,
administrator). A teller receives **403** `AUTHORIZATION_DENIED` with
`TELLER_MESSAGE`. The same key, `web:transfer-cancel:<transactionId>`,
returns the stored reversal and posts nothing again. A different key after
a successful reversal finds the obligation already reversed and is
**422** `REVERSAL_NOT_ALLOWED`. It moves nothing.

Payout requires `transaction:post`. It writes `ledger_obligations.paid_out_at`
and moves no cash. A later reversal is **422** `REVERSAL_NOT_ALLOWED` with
"Already paid out to the customer." A settled obligation gets the same
refusal. A reversed obligation is "Already cancelled." A held obligation
is "On hold. Release it first, then cancel." Hold and release are
`POST /api/ledger/obligation-deals/:transactionId/hold` and `.../release`.
They change the server status and move no cash.

A send that is still open needs `partnerConfirmedNotPaid: true`. The
reversal stores that on `ledger_reversals.partner_confirmed_not_paid`,
with the reason. The reason is at least 3 characters. The timeline line
is `Cancelled by <name> at <h:mm AM>, <reason>`.

Transfers that were marked paid only in the browser, before `paid_out_at`
existed, stay open with `paid_out_at` null. Nothing backfills that
timestamp. Cancelling one still requires the partner confirmation.

A cancel needs an open till session. With none, the response is **422**
`REVERSAL_NOT_ALLOWED` and the message "Open the till before cancelling a
transfer." Nothing is posted, so the signed-off day's totals stay. When a
session is open, `ledger_reversals.till_session_id` is that session.
`business_date` is the branch's calendar day from `branches.timezone` at
the moment of the cancel. Just after midnight at the shop, that day is
the shop's day. PR #128's `businessDate(at, timeZone)` helper is not on
main. A branch with no timezone on file keeps the open session's stored
business date. A reversal posted outside a summary window does not take
the original deal out of that window.

A receive (`remittance_receive`) is **422** `REVERSAL_NOT_ALLOWED` with
`RECEIVE_MESSAGE`. This screen does not collect the cash back.

```
GET /api/ledger/obligation-deals/:transactionId
```

`ledger:view`. Unknown id is **404** `TRANSACTION_NOT_FOUND`, "That transfer
is not on the ledger."

## What the reversal does to the money

The existing reversal is used unchanged. For a send of 600.00 plus a 9.99 fee
it credits the till 609.99 (cash back to the customer, fee included), debits
`liability:remittance_payable` 600.00, and debits `revenue:fee` 9.99. The fee
is refunded because the reversal mirrors every journal line, and the fee was
one of those lines. Cancel means the deal never stood. A cheque NSF is a
different act and still keeps its fee.

Do not call `POST /api/ledger/transactions/:id/reversal` for a remittance. That
path mirrors the cash and leaves the obligation open.
