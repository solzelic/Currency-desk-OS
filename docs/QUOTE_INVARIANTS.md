# Quote Invariants

- A quote is scoped to tenant, legal entity, branch, workspace, till, customer,
  and creator. A supplied out-of-scope workspace fails closed.
- An active quote freezes input, output, rate, market mid, fee, spread, board
  publication, and snapshot lineage. Later board publications do not alter it.
- Activated quote terms are immutable in PostgreSQL. Status may progress from
  active to expired, cancelled, or posted; posted and cancelled quotes cannot
  be posted.
- A re-quote creates a new quote referencing `supersedes_quote_id`; it does not
  alter the original financial terms.
- Ledger posting consumes the frozen quote terms and validates quote scope,
  expiry, customer, permission, liquidity, idempotency, and balanced journal.
- The current fee contract is separate CAD tender. It is explicit in receipt,
  till movements, and the CAD functional-currency journal.

Current limitations: no live KYC provider or production market-data assurance;
the newest market snapshot is associated when available but publication-to-
snapshot provenance is not yet a database foreign key. Override policy and
limits require product, compliance, and legal approval before production use.
