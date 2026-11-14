# Database migrations — the contract

(This filename used to hold the abandoned 2026-07 frontend migration plan;
git history has it. This is the real, load-bearing migration contract,
consolidated from the ledger workstream's hard-won rules.)

## Adding a migration means THREE places

Missing any one of them fails silently:

1. The SQL file: `server/src/db/migrations/NNN_name.sql` — the name
   describes the schema change.
2. Register it in the ordered list in `server/src/db/migrations.ts`.
3. If it touches a Drizzle-managed table: add the column to the `DDL`
   constant in `server/src/db/index.ts` **and** to
   `server/src/db/schema.ts`.

Ledger tables are the exception — they are created by
`server/src/ledger/migration.sql` (registered as migration `001_ledger`)
and are deliberately absent from `DDL`.

## Immutability and checksums

Migrations are **immutable once merged/applied**. Every applied migration's
checksum is recorded in `schema_migrations`; editing an applied file raises
`Migration checksum drift` at boot rather than silently diverging
(`server/tests/migrations.postgres.test.ts` pins this, along with
partial-failure rollback). Need a change? Write the next migration.
Never rename a migration file after merge.

## How they run

Boot applies everything: `createDb()` runs `DDL` (idempotent
`IF NOT EXISTS`) and then `runMigrations` against a Postgres
`DATABASE_URL` — a fresh database self-provisions exactly the way a fresh
deployment does. The embedded PGlite database applies `DDL` but **not**
the SQL migrations, which is why the ledger only exists when a real
database URL is configured, and why the known "two schema mechanisms"
debt exists (`docs/ARCHITECTURE.md` §8).

Operational commands: `cd server && npm run ledger:migrate` applies
migrations by hand; `npm run ledger:seed` seeds ledger fixtures.

### Columns with constraints in the boot DDL

The shared DDL runs **before** Postgres migrations and on every embedded
boot. A migration must not assume that adding its column also adds its
constraint: `ADD COLUMN IF NOT EXISTS` may already be a no-op. Migration
074 (`legal_entities.timezone`) adds the nullable text column, then ensures
the named nonblank CHECK exists. The DDL mirrors both operations, so fresh
Postgres, legacy upgrades and embedded PGlite enforce the same check.
Neither operation backfills rows or supplies a default; existing entities
stay NULL and keep the resolver's branch fallback. IANA validity is checked
by the service. The runner also supports an earlier migration arriving
after 074: identifiers are sorted and recorded independently, not treated
as a single high-water mark.
