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
| `TELLER_MESSAGE` | `Only the owner can cancel a transfer that took cash. Ask the owner to cancel.` |
| `PAID_OUT_MESSAGE` | `This transfer was already paid out. It cannot be cancelled.` |
| `canPost(role)` | true for Owner, Manager, and Senior teller. Those OS roles already map to `transaction:reverse`. Cashier and Trainee are false. This grants nothing. |
| `review(obligation)` | `{ kind: "confirm", sentence }` or `{ kind, message }`. The sentence is built from the obligation row. It does not add the fee and it does not price the corridor. |
| `idempotencyKey(transactionId)` | `web:transfer-cancel:<transactionId>`. Stable for the life of the deal, so a second tap replays. |
| `paidOutKey(transactionId)` | `web:transfer-paid:<transactionId>`. |
| `postCancel(transactionId)` | `POST /api/ledger/obligation-deals/:transactionId/reversal` with that key and reason `Cancelled at the counter`. Retries once on `IDEMPOTENCY_IN_PROGRESS`. Any other error is thrown. |
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
`TELLER_MESSAGE`. The same key returns the stored reversal and does not move
cash again. A different key after a successful reversal is
`REVERSAL_ALREADY_EXISTS` and moves nothing.

Payout requires `transaction:post`. It writes `ledger_obligations.paid_out_at`
and moves no cash. A later reversal is **422** `REVERSAL_NOT_ALLOWED` with
`PAID_OUT_MESSAGE`. A settled obligation gets the same refusal: the partner
has already been funded.

## What the reversal does to the money

The existing reversal is used unchanged. For a send of 600.00 plus a 9.99 fee
it credits the till 609.99 (cash back to the customer, fee included), debits
`liability:remittance_payable` 600.00, and debits `revenue:fee` 9.99. The fee
is refunded because the reversal mirrors every journal line, and the fee was
one of those lines. Cancel means the deal never stood. A cheque NSF is a
different act and still keeps its fee.

Do not call `POST /api/ledger/transactions/:id/reversal` for a remittance. That
path mirrors the cash and leaves the obligation open.
