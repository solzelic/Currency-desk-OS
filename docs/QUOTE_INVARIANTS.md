# Quote Invariants

- A quote is scoped to tenant, legal entity, branch, workspace, till, customer,
  and creator. A supplied out-of-scope workspace fails closed.
- An active quote freezes input, output, rate, market mid, fee, spread, board
  publication, and snapshot lineage. Later board publications do not alter it.
- The exchange output on the sheet is that frozen output. A fee is separate
  home-currency tender: the customer hands over input plus the fee when they
  pay home currency, and takes output less the fee when they receive it. The
  teller's You give / You receive headline is that net. The customer screen
  shows the net on its own line and the fee under it. The frozen input,
  output, and fee stay the figures the ledger posts. The rate drawn for the
  customer, and on the phone rate field, is 4 decimal places. The posted
  amount is still `input ×` the full rate. Before the quote exists, the
  preview is the same function (`os-src/quote-terms.js`), not a second rounding.
- Activated quote terms are immutable in PostgreSQL. Status may progress from
  active to expired, cancelled, or posted; posted and cancelled quotes cannot
  be posted.
- A re-quote creates a new quote referencing `supersedes_quote_id`; it does not
  alter the original financial terms.
- Ledger posting consumes the frozen quote terms and validates quote scope,
  expiry, customer, permission, liquidity, idempotency, and balanced journal.
- A post carries the Customer receives amount the teller was shown. The
  server recomputes that amount and refuses with `409 RELOAD_REQUIRED`
  when it is missing or different. Nothing is posted.
- The sheet reads quote errors from one table in `os-src/quote-terms.js`.
  A message that table does not name is `Couldn't get a price. Reload and
  try again.`, never the server's own sentence.
- The current fee contract is separate CAD tender. It is explicit in receipt,
  till movements, and the CAD functional-currency journal.
- A quote-originated transaction retains `quote_id`, `market_mid`, rate-board
  publication and market-snapshot IDs, rate source type, and any override ID.
  The posted transaction is append-only, so later board or quote changes cannot
  change historical lineage.
- The Canadian pilot originally required exactly one CAD currency leg.
  **Amended**: desks whose jurisdiction pack sets `allow_cross_currency`
  post foreign-to-foreign deals — two frozen board rows, margin on both
  legs (`docs/JURISDICTION_PACK_ARCHITECTURE.md`,
  `server/tests/cross-currency.postgres.test.ts`).

Current limitations: no live KYC provider or production market-data assurance;
the newest market snapshot is associated when available but publication-to-
snapshot provenance is not yet a database foreign key. Override policy and
limits require product, compliance, and legal approval before production use.
