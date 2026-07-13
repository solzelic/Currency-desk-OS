# Quote Service

`POST /api/quotes` accepts only `customerId`, `from`, `to`, `inputAmount`,
`feeCad`, direction, and optional `supersedesQuoteId`. The server resolves the
session scope, loads the newest published board in that exact branch, and
returns decimal-string quote terms with publication and market-snapshot
lineage. Raw browser rates are never accepted.

Direction semantics: `customer_buy_foreign` means CAD to foreign currency and
uses the board's **We Sell** margin. `customer_sell_foreign` means foreign
currency to CAD and uses **We Buy**. `customerRate` is always output units per
input unit; `marketMid` remains CAD per unit of foreign currency.

Endpoints: `POST /api/quotes`, `GET /api/quotes/:quoteId`,
`POST /api/quotes/:quoteId/cancel`, `POST /api/quotes/:quoteId/override`, and
`POST /api/quotes/:quoteId/post`.

Active quotes expire after `QUOTE_TTL_SECONDS` (60 seconds by default).
`RATE_BOARD_MAX_AGE_SECONDS` defaults to 300. `QUOTE_OVERRIDE_MAX_DEVIATION`
defaults to `0.05` (5%). All money and rate response fields are decimal
strings.

Overrides require `rates:override`, a reason, active scope, and a rate within
the configured deviation. The original quote rate and market mid are retained;
the override record stores the changed rate, output, spread, actor, timestamp,
and reason.

Posting verifies the active, unexpired quote and calls the ledger with frozen
terms. The ledger re-reads the scoped quote, verifies its status and terms,
creates the transaction and receipt atomically, and marks the quote posted.

Stable failures include `AUTHENTICATION_REQUIRED`, `SCOPE_DENIED`,
`AUTHORIZATION_DENIED`, `INVALID_REQUEST`, `RATE_NOT_AVAILABLE`,
`RATE_PUBLICATION_STALE`, `QUOTE_NOT_FOUND`, `QUOTE_NOT_ACTIVE`,
`QUOTE_EXPIRED`, `QUOTE_MISMATCH`, `OVERRIDE_LIMIT_EXCEEDED`, and the ledger
posting failures documented in `LEDGER_POSTING_API.md`.
