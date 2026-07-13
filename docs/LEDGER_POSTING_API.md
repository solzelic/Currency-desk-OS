# Ledger Posting API

The ledger service is the authoritative backend boundary. It accepts transaction inputs, not browser-calculated totals. PostgreSQL `numeric` and `decimal.js` derive the quote, CAD valuation, spread, journal, till movements, receipt response, and audit evidence in one serializable transaction.

## Endpoints

| Method | Path | Auth | Result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | none | Liveness response. |
| `POST` | `/api/ledger/exchanges` | session cookie | Posts an exchange with a required idempotency key. |
| `POST` | `/api/ledger/transactions/:transactionId/reversal` | session cookie + `transaction:reverse` | Creates an explicit reversal with a required reason. |

The authenticated actor is resolved from the server session. Tenant, legal entity, branch, workspace, user, till, and authorized branches are not accepted from request JSON.

## Failure codes

`AUTHENTICATION_REQUIRED`, `AUTHORIZATION_DENIED`, `SCOPE_DENIED`, `CUSTOMER_NOT_FOUND`, `INVALID_REQUEST`, `COMPLIANCE_BLOCKED`, `INSUFFICIENT_TILL_LIQUIDITY`, `RATE_NOT_AVAILABLE`, `IDEMPOTENCY_IN_PROGRESS`, `TRANSACTION_NOT_FOUND`, `REVERSAL_NOT_ALLOWED`, and `REVERSAL_ALREADY_EXISTS` are stable response codes.

## Local commands

See [server/README.md](../server/README.md) for isolated PostgreSQL startup, migration, seed, API start, and real integration-test commands.

## Limitations

No live-rate or KYC provider is connected. The current internal rate table is synthetic test/demo data. Production migration management, secret injection, observability, and authenticated workspace selection remain deployment work.
