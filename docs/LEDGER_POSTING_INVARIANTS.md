# Ledger Posting Invariants

- PostgreSQL is authoritative. API money values are decimal strings; JavaScript floating-point values are never stored.
- Posting locks and validates principal, customer, rates, and destination till under tenant/legal-entity/branch/workspace/till scope.
- `transaction:post` and `transaction:reverse` are enforced at the server boundary.
- The journal balances in the entity's functional currency before any entry
  is inserted ("CAD" throughout this document means the legal entity's home
  currency — jurisdiction packs generalised it, see
  `docs/JURISDICTION_PACK_ARCHITECTURE.md`): home value of source cash plus
  separately tendered home-currency fee debit; destination cash, FX spread
  revenue, and fee revenue credits. Both fee and no-fee journals are tested.
- A successful post appends a transaction, balanced journal, till movements, audit event, and idempotency response atomically.
- A serialization failure (Postgres 40001) on a direct post or a frozen
  quote post is run again, up to six times. The failure is not rewritten
  as a duplicate in progress. A frozen quote another attempt has already
  posted returns that stored post. A key already saved with no stored
  answer is posted once. It does not come back as `IDEMPOTENCY_IN_PROGRESS`.
- Posted transactions, journals, movements, and audit rows are append-only.
  Reversals append compensating journal and till movements and preserve the
  original transaction. Reversal movements carry both `reversal_id` and
  `movement_kind = 'reversal'`, while original movements are marked
  `movement_kind = 'original'`.
- The unique reversal link prevents an original transaction from being reversed twice.
- `POST /api/ledger/transactions/:transactionId/reversal` refuses
  `cheque_cashing`, `cheque_clearing`, and `cheque_return`
  (`REVERSAL_NOT_ALLOWED`) and names
  `POST /api/ledger/cheques/:chequeId/reversal`. The cheque row and its
  events stay as they were. A cashing is reversed on that cheque route.
