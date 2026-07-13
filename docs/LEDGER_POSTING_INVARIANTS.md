# Ledger Posting Invariants

- PostgreSQL is authoritative. API money values are decimal strings; JavaScript floating-point values are never stored.
- Posting locks and validates principal, customer, rates, and destination till under tenant/legal-entity/branch/workspace/till scope.
- `transaction:post` and `transaction:reverse` are enforced at the server boundary.
- The journal balances in CAD functional currency: cash received plus fee debit; cash paid, FX spread revenue, and fee revenue credits.
- A successful post appends a transaction, balanced journal, till movements, audit event, and idempotency response atomically.
- Posted transactions, journals, movements, and audit rows are append-only. Reversals append compensating journal and till movements and preserve the original transaction.
- The unique reversal link prevents an original transaction from being reversed twice.
