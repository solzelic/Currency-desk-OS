# Jurisdiction Pack Architecture

## Status

Phases 1 and 2 are built. `jurisdiction_packs` exists and is seeded for CA,
US, GB, EU, AU and AE; `legal_entities` carries `home_currency`,
`jurisdiction_pack_id` and `jurisdiction_pack_version`; the country chosen at
onboarding installs the pack; and the posting path resolves home currency
from it rather than assuming CAD. Generalized money columns are added and
backfilled alongside the CAD-named ones — nothing is renamed or retired yet.

A pack can also name an identification line per kind of deal
(`jurisdiction_id_thresholds`: foreign exchange, remittance, electronic
funds transfer, virtual currency). Null means that kind has no line.
Zero means every deal of that kind. A line can say `gte` or `gt`, a
due-diligence level (`identify`, `cdd`, `edd`), and whether it is
cash-only. A country pack's posting gate still reads the single
`id_threshold` column. The baseline gate reads the per-deal rows.
Seeded packs copy a positive value of that
column onto all four kinds, so the two agree. Zero on the old column
is not copied. A report row can name a filing deadline (`immediately`,
`hours`, `before_execution`, `monthly_day`, `calendar_days`,
`business_days`), an aggregation window (`fixed_24h`, `calendar_month`,
`rolling_days`, `banking_day`, or `none`), a comparator (`gte` or `gt`),
a cash direction, whether it counts cash only, and the currency the
threshold is written in. A baseline threshold written in US dollars
is converted to the desk's home currency at the newest market
snapshot. The six country packs still state their thresholds in home
currency. Seeded report rows were mapped onto those columns
without changing a trigger amount. Only `aggregation_hours = 24` is
labelled `fixed_24h`. A country with no installed pack resolves to `pack-intl-v1`, the
international baseline. It is not given the Canada pack, and new deals
are not paused. A quote, exchange, frozen quote, remittance send or
receive, bill payment, money order, cheque cashing, and a threshold
override all post under that baseline. Clearing or returning a cheque
already held, settling or writing off an obligation already open, and
voiding a deal already posted still succeed. A settlement row carries
the pack the original deal was stamped with, or NULL when that deal
has none.

The baseline is not a country. Its identification lines are in US
dollars: 3,000 for a cash foreign exchange, 1,000 for a remittance, an
electronic transfer, or virtual currency. The large-cash record is
10,000 USD in a fixed 24-hour window. The regulator field is empty.
A USD line is converted to the desk's home currency at the newest
market snapshot, rounded down to the cent, and the rate and its
timestamp are stored on the deal. The identification line and the
large-cash line the till reads are converted the same way. A missing
or stale snapshot leaves both unset, so identification and the
purpose and source of funds are required on every deal. A baseline desk that names no home currency books in USD. The
till and Settings show the international-rules disclaimer.
Compliance names International baseline (FATF), no regulator, and
the three generic reports. A money line is a plain sentence: the
converted home amount, then the US-dollar figure it came from. A
stricter line names the desk's own figure and that converted
baseline separately. The US-dollar source is not attached to the
owner's lower number. A missing rate says identification is
required on every deal. The new-transfer form compares its Canadian
figure with these lines in the desk's home currency, and requires
identification when that figure cannot be converted.

A new exchange, transfer, or cheque cashing stamps
`jurisdiction_pack_id`, `jurisdiction_pack_version`, and `home_currency`
on the transaction row. Rows written before that are not rewritten.
Migration 028 backfills a missing pack to the Canada pack where the
home currency is CAD, empty, or null, and stores CAD in that case.
GBP, AUD, AED, EUR, USD, and every other currency are pointed at the
baseline and keep their home currency. The known-wrong country packs
are not assigned, because those seeded numbers are wrong.

Still to do: dual-write the generalized fee and spread amounts on every
posting (step 4; cheques already do this), make them authoritative
(step 5), and retire the CAD-specific columns (step 6). Compliance
policy versioning is not started.

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

- Canada: `homeCurrency=CAD`; CAD/USD allowed.
- United States: `homeCurrency=USD`; USD/EUR allowed.
- Eurozone: `homeCurrency=EUR`; EUR/GBP allowed.

**Amended:** this document originally specified that a deal without the home
currency on one side is rejected — "USD/EUR rejected" for Canada. That was
the pilot's limitation written down as a rule. A customer arriving with
dollars and wanting euros is ordinary business for a currency desk, so
cross-currency is a CAPABILITY on the pack (`allow_cross_currency`), on by
default, and a jurisdiction that genuinely forbids it turns it off.

Each configuration requires fee-in-home-currency, home-value journal balance,
cross-entity isolation, historical snapshot, and compliance-policy-version
tests.

## Migration Phases

1. Configuration tables and immutable historical snapshots.
2. Dual-write generalized monetary values.
3. Jurisdiction-aware quote and ledger calculation.
4. Policy-driven compliance facts.
5. Reporting and reconciliation migration.
