# Ledger Posting API

## Boundary

`LedgerPostingService` is the backend application boundary for authoritative currency-exchange posting. It accepts an authenticated server principal, never browser-provided totals, and uses PostgreSQL `numeric` values plus `Decimal` arithmetic.

## Contracts

`POST /v1/ledger/exchanges` accepts `idempotencyKey`, `customerId`, `from`, `to`, `inputAmount`, `feeCad`, `purpose`, and `sourceOfFunds`. The server derives output amount, rate, CAD values, spread, journal entries, receipt, and till movements.

`POST /v1/ledger/transactions/{transactionId}/reversal` accepts `idempotencyKey` and non-empty `reason`. It requires `transaction:reverse`; the original transaction, journal, and till movements remain immutable evidence.

The authenticated context is supplied by server middleware and contains tenant, legal entity, branch, workspace, till, user, role, and authorized branches. It must not be accepted from request JSON.

## Stable response

The success response contains `transactionId`, `transactionRef`, authoritative amounts as decimal strings, `postedAt`, and receipt-ready lines. Retrying a completed idempotency key returns the stored response.

## Failure codes

`AUTHENTICATION_REQUIRED`, `SCOPE_DENIED`, `AUTHORIZATION_DENIED`, `CUSTOMER_NOT_FOUND`, `INVALID_REQUEST`, `COMPLIANCE_BLOCKED`, `INSUFFICIENT_TILL_LIQUIDITY`, `RATE_NOT_AVAILABLE`, `IDEMPOTENCY_IN_PROGRESS`, `TRANSACTION_NOT_FOUND`, `REVERSAL_ALREADY_EXISTS`, and `REVERSAL_NOT_ALLOWED` are stable machine-readable outcomes.

## Known limitations

- No live rate or KYC provider is connected. Rates are sourced from the scoped internal `ledger_rates` table.
- Database users, migrations, API authentication middleware, retry policy, and operational observability must be provisioned by deployment infrastructure.
- The first implementation supports the demo currency set and the documented CAD functional-currency accounting model.

## Test commands

- `npm run test` runs deterministic unit and service-concurrency coverage.
- `TEST_DATABASE_URL=postgres://... npm run test:integration` applies the isolated test schema and checks PostgreSQL uniqueness behavior. It must target an isolated disposable database, never production.
