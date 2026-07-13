# Ledger Posting Invariants

- PostgreSQL is authoritative. API money values are decimal strings; JavaScript floating-point values are never stored.
- Posting locks and validates principal, customer, rates, and destination till under tenant/legal-entity/branch/workspace/till scope.
- `transaction:post` and `transaction:reverse` are enforced at the server boundary.
- The journal balances in CAD functional currency before any entry is inserted:
  CAD value of source cash plus separately tendered CAD fee debit; destination
  cash, FX spread revenue, and fee revenue credits. Both fee and no-fee
  journals are tested.
- A successful post appends a transaction, balanced journal, till movements, audit event, and idempotency response atomically.
- Posted transactions, journals, movements, and audit rows are append-only.
  Reversals append compensating journal and till movements and preserve the
  original transaction. Reversal movements carry both `reversal_id` and
  `movement_kind = 'reversal'`, while original movements are marked
  `movement_kind = 'original'`.
- The unique reversal link prevents an original transaction from being reversed twice.
