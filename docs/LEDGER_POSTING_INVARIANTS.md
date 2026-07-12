# Ledger Posting Invariants

1. PostgreSQL is authoritative; frontend amounts are inputs only.
2. Monetary storage is `numeric(24,2)` and rates are `numeric(24,12)`; API values are decimal strings.
3. One serializable transaction claims idempotency, locks scope/customer/till/rates, posts records, updates till balances, appends audit evidence, and stores the response.
4. The authenticated actor, customer, rates, till, idempotency key, and every write share tenant/legal-entity/branch/workspace/till scope.
5. `transaction:post` is checked against the database-backed actor before posting; `transaction:reverse` is checked before reversal.
6. The journal is balanced in CAD functional currency: debit cash received plus fee; credit cash paid, FX spread revenue, and fee revenue.
7. Posted transaction/journal/till movement/audit records are append-only. A reversal appends linked inverse journal entries, inverse till movements, and audit evidence; it never updates or deletes the original evidence.
8. A unique `transaction_reversals.original_transaction_id` prevents double reversal.
