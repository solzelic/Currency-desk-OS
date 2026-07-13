# Ledger Posting API

The ledger service is the authoritative backend boundary. It accepts transaction inputs, not browser-calculated totals. PostgreSQL `numeric` and `decimal.js` derive the quote, CAD valuation, spread, journal, till movements, receipt response, and audit evidence in one serializable transaction.

The direct exchange endpoint is retained only for legacy/demo compatibility and
does not apply a commercial multiplier. Production commercial pricing is
created by the Quote Service and posted through frozen quote terms.

## Endpoints

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | none | Liveness response. |
| `POST` | `/api/ledger/exchanges` | session cookie | Posts an exchange with a required idempotency key. |
| `POST` | `/api/ledger/transactions/:transactionId/reversal` | session cookie + `transaction:reverse` | Creates an explicit reversal with a required reason. |

The authenticated actor is resolved from the server session. Tenant, legal entity, branch, workspace, user, till, and authorized branches are not accepted from request JSON.

`x-workspace-id` is optional only when the authenticated session has exactly one
workspace in its tenant, legal-entity, and branch scope. A supplied workspace
that is missing or out of scope returns `403 SCOPE_DENIED`; it never falls back
to a different workspace.

## Money and Fees

Amounts are canonical decimal strings with up to two fractional places, a
maximum value of `1,000,000,000.00`, and no exponent notation. `inputAmount`
must be positive and `feeCad` must be non-negative. The API rejects identical
currencies and bounded text fields beyond their documented limits.

Field limits are: idempotency key 200 characters, customer ID 120 characters,
purpose 500 characters, source of funds 500 characters, and reversal reason
1-1,000 characters.

The explicit current product rule is that `feeCad` is separate CAD tender. It
is **not** included in the currency being exchanged. The till receives the
source currency at `inputAmount` and separately receives CAD at `feeCad`; the
receipt has a separate CAD fee line. The journal debits the functional-CAD
value of source cash plus the CAD fee, then credits destination-cash value, FX
spread revenue, and fee revenue. This rule requires product and policy signoff
before any production rollout; the API name makes the CAD denomination
intentional rather than inferred.

## Failure codes

`AUTHENTICATION_REQUIRED` is returned only when no valid session exists.
`SCOPE_DENIED` is returned when a valid session is outside tenant, legal
entity, branch, workspace, or till scope. `AUTHORIZATION_DENIED` is returned
when the database-authoritative principal lacks the named permission.
`INVALID_REQUEST`, `CUSTOMER_NOT_FOUND`, `COMPLIANCE_BLOCKED`,
`INSUFFICIENT_TILL_LIQUIDITY`, `RATE_NOT_AVAILABLE`,
`IDEMPOTENCY_IN_PROGRESS`, `TRANSACTION_NOT_FOUND`, `REVERSAL_NOT_ALLOWED`,
and `REVERSAL_ALREADY_EXISTS` are stable response codes. Unexpected failures
are logged server-side and return only `500 INTERNAL_ERROR`.

## Local commands

See [server/README.md](../server/README.md) for isolated PostgreSQL startup, migration, seed, API start, and real integration-test commands.

## Limitations

No live-rate or KYC provider is connected. The current internal rate table is synthetic test/demo data. Production migration management, secret injection, observability, and authenticated workspace selection remain deployment work.
