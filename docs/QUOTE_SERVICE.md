# Quote Service

`POST /api/quotes` accepts only `customerId`, `from`, `to`, `inputAmount`,
`feeCad`, direction, and optional `supersedesQuoteId`. The server resolves the
session scope, loads the newest published board in that exact branch, and
returns decimal-string quote terms with publication and market-snapshot
lineage. Raw browser rates are never accepted.

The current Canadian pilot accepts an exchange only when CAD is exactly one
leg. This is a pilot configuration, not a universal product rule; a future
jurisdiction-pack migration will make home currency legal-entity specific.

Direction semantics: `customer_buy_foreign` means home currency to foreign
currency and uses the board's **We Sell** margin. `customer_sell_foreign`
means foreign currency to home currency and uses **We Buy**. `customerRate`
is always output units per input unit; `marketMid` remains home currency per
unit of foreign currency.

The output amount is `input × customerRate`, rounded half-up to the output
currency's minor units (a yen to a whole yen, a dollar to a cent). The
customer rate is not rounded before that multiply, and the published mid is
not rounded to four places before the margin. `os-src/quote-terms.js` is
that function. The New transaction sheet previews with it, and once a quote
is frozen the sheet shows the frozen input, output, and rate rather than a
second product. The You give / You receive line is the cash the till moves:
input plus the fee when the customer pays home currency, output less the
fee when they receive it. Those three frozen figures stay authoritative.
The rate stored on the quote is still 12 decimal places. A quote whose
payout is zero, including a fee that consumes a home-currency payout, is
refused with `422 ZERO_PAYOUT`.

The desk page carries the build id from `web/app/build-id.txt` and sends
it as `x-currencydesk-build` on quote create and post. A different id is
`409 RELOAD_REQUIRED`. A request with no id is still accepted, because
the desk on main does not send one. Once that script sends the id, a
missing id is the same refusal.

`POST /api/quotes/:quoteId/post` also carries `shownAmount`, the Customer
receives figure the teller was looking at. The server recomputes that
figure from the frozen input, rate, fee, and currencies, and answers
`409 RELOAD_REQUIRED` when the field is missing or different. Nothing
is posted. The sheet shows `This screen is out of date. Reload to continue.`
with a Reload button.

The sheet does not show the server's own sentence. `os-src/quote-terms.js`
holds one table from the raw message to the words on the sheet. A message
the table does not name reads `Couldn't get a price. Reload and try again.`
`Quote pricing did not load.` reads `Prices didn't load. Reload the page.`

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

Posting requires non-empty `purpose` and `sourceOfFunds` (maximum 500
characters each) in addition to an idempotency key. It verifies the active,
unexpired quote and calls the ledger with frozen terms. The ledger re-reads the
scoped quote, Decimal-compares every financial and lineage term, creates the
transaction, journal, till movements, audit event, receipt response, and quote
status transition atomically.

For this Canadian pilot, `feeCad` is separate CAD tender, not part of the
exchange input. The journal records it as a dedicated `till:CAD` debit and
`revenue:fee` credit. Quote-originated transactions permanently retain quote
ID, market mid, publication ID, snapshot ID, source type, and optional override
ID; later board publications cannot alter that history.

Stable failures include `AUTHENTICATION_REQUIRED`, `SCOPE_DENIED`,
`AUTHORIZATION_DENIED`, `INVALID_REQUEST`, `RATE_NOT_AVAILABLE`,
`RATE_PUBLICATION_STALE`, `QUOTE_NOT_FOUND`, `QUOTE_NOT_ACTIVE`,
`QUOTE_EXPIRED`, `QUOTE_MISMATCH`, `ZERO_PAYOUT`, `RELOAD_REQUIRED`,
`OVERRIDE_LIMIT_EXCEEDED`, and the ledger
posting failures documented in `LEDGER_POSTING_API.md`.

The API is intentionally fail-closed until a workspace has relational ledger
principals, customers, and till balances. The browser OS posts through these
endpoints (`os-src/cdos-backend.js` → `POST /api/quotes`, `/override`,
`/post`); provisioning creates the workspace rows at onboarding. The
original single-CAD-leg pilot constraint has been generalised — desks with
`allow_cross_currency` post foreign-to-foreign deals
(`docs/JURISDICTION_PACK_ARCHITECTURE.md`).
