# Jurisdiction Pack Architecture

## Status

This is a future migration design. PR #7 remains the Canadian pilot and uses
CAD as its current home currency. CAD is not a universal product rule.

## Target Configuration

`legal_entities` will gain authoritative `home_currency`,
`jurisdiction_pack_id`, and `jurisdiction_pack_version`. A new
`jurisdiction_packs` registry will contain `pack_id`, jurisdiction code,
version, home currency, compliance policy ID, quote/rate defaults, required
transaction fields, and reporting profile.

Compliance policies will be versioned independently. The posting boundary will
receive authoritative validated facts and a policy snapshot rather than embed
universal purpose/source-of-funds rules.

## Financial Generalization

New records will use `fee_amount` and `fee_currency`, with pilot fees collected
separately in the legal entity home currency. CAD-specific value columns will
be evolved non-destructively to `spread_home_amount`, `amount_home`, and an
explicit `home_currency`. Posted quotes and transactions will snapshot home
currency, jurisdiction pack/version, policy version, fee currency/amount, and
rate lineage so later configuration changes cannot rewrite history.

## Compatibility Migration

1. Add nullable generalized columns and jurisdiction-pack tables.
2. Seed a Canadian pack/version and backfill existing legal entities with CAD.
3. Backfill existing CAD fee/spread/journal values into generalized columns.
4. Dual-read and validate old/new values during a compatibility release.
5. Make generalized fields authoritative only after reconciliation.
6. Retire CAD-specific fields in a later, separately approved migration.

No destructive rename occurs in the initial migration.

## Test Configurations

- Canada: `homeCurrency=CAD`; CAD/USD allowed, USD/EUR rejected.
- United States: `homeCurrency=USD`; USD/EUR allowed, CAD/EUR rejected.
- Eurozone: `homeCurrency=EUR`; EUR/GBP allowed, USD/GBP rejected.

Each configuration requires fee-in-home-currency, home-value journal balance,
cross-entity isolation, historical snapshot, and compliance-policy-version
tests.

## Migration Phases

1. Configuration tables and immutable historical snapshots.
2. Dual-write generalized monetary values.
3. Jurisdiction-aware quote and ledger calculation.
4. Policy-driven compliance facts.
5. Reporting and reconciliation migration.
