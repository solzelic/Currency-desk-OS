# CurrencyDesk Server

The Fastify backend for the whole product: auth and tenancy, the Postgres
ledger, quotes, client records, rates, hosted storefronts, billing, the
growth pipeline — and all static serving in production (one origin, no
CORS). The frontends it serves are the buildless OS (`os-src/`), the admin
panel, and the generated site under `web/` — see `docs/REPOSITORY_MAP.md`.

## Stack

- **Fastify** (HTTP) + **Zod** (validation)
- **Drizzle ORM** on **Postgres** — embedded [PGlite](https://pglite.dev) locally (zero install), `DATABASE_URL` against managed Postgres in production. Same SQL either way.
- Sessions: opaque tokens in an `httpOnly` cookie; the DB stores only the SHA-256 of the token. 12-hour TTL, revocable on logout.
- Passwords: scrypt via `node:crypto` (no native deps), parameters embedded per-hash so they can be raised later.

## Tenancy model

Mirrors the frontend's `DomainScope` exactly:

```
tenant (exchange group)
└─ legal entity (registered MSB, jurisdiction)
   └─ branch
      └─ workspace (till/station)
```

Staff belong to a tenant + legal entity + home branch, with `authorizedBranchIds` for cross-branch access. Roles are the enum in `server/src/db/index.ts` (`teller` … `auditor`); the server is the single authority on authorization.

## Run

```sh
cd server
npm ci
npm run dev:prototype   # http://127.0.0.1:8787 — site at /, OS at /app, embedded DB, auto-seeded
```

Demo accounts (any of `j.masri`, `r.haddad`, `a.singh`), password `yorkville`. **Demo only.**

## API

Routes are registered per domain in `server/src/app.ts`: auth, signup,
enquiries, early access, PINs, staff, desk, tenant, tenant-state, admin,
growth, public onboarding, public site, rates, billing — plus the ledger,
quote and client-records routes (44+ under `/api/ledger` and `/api/quotes`),
which register only when a database URL is configured. The route map lives
in `docs/REPOSITORY_MAP.md`; the ledger surface in
`docs/LEDGER_POSTING_API.md` and `docs/QUOTE_SERVICE.md`.

Login failures are uniform (`invalid_credentials`) to prevent staff-ID enumeration, and every attempt lands in `audit_events`.

## Test

```sh
npm run typecheck && npm test
```

Integration tests run the full HTTP app against an in-memory PGlite instance.

## Lead research and outbound calls

The admin application page can run sourced Tavily research and place a
guarded ElevenLabs call. Both integrations are optional and remain disabled
when their environment variables are absent. Consent evidence, research
snapshots, sourced facts and call history are stored separately from the
applicant's own `enquiries.details` answers. See
[`docs/GROWTH_PIPELINE.md`](../docs/GROWTH_PIPELINE.md) for configuration,
safety gates and webhook setup.

## Ledger posting (isolated local PostgreSQL)

```sh
# terminal 1: disposable PostgreSQL 16 cluster
initdb -D /private/tmp/cdos-postgres
pg_ctl -D /private/tmp/cdos-postgres -o "-p 54329" -l /private/tmp/cdos-postgres.log start
createdb -p 54329 currencydesk_ledger_test

# terminal 2: apply tracked migrations and seed only the disposable database
cd server
DATABASE_URL=postgres://$USER@127.0.0.1:54329/currencydesk_ledger_test npm run ledger:migrate
DATABASE_URL=postgres://$USER@127.0.0.1:54329/currencydesk_ledger_test npm run ledger:seed

# local API: embedded demo auth + real PostgreSQL ledger
LEDGER_DATABASE_URL=postgres://$USER@127.0.0.1:54329/currencydesk_ledger_test npm run dev
# GET http://127.0.0.1:8787/api/health

# actual PostgreSQL ledger integration suite
TEST_DATABASE_URL=postgres://$USER@127.0.0.1:54329/currencydesk_ledger_test npm run test:ledger:postgres
```

The isolated cluster is development/test only. Never set these URLs to a production database. The ledger endpoints require an authenticated session, are scoped to the active workspace, and are available at `POST /api/ledger/exchanges` and `POST /api/ledger/transactions/:transactionId/reversal`.

Quote endpoints use the same database lifecycle: `POST /api/quotes` creates an
authoritative 60-second quote from the published branch board, and
`POST /api/quotes/:quoteId/post` posts its frozen terms.

### Authoritative deployment sequence

Tracked migrations run automatically during application startup when
`DATABASE_URL` is configured. The server creates `schema_migrations`, applies
each migration in deterministic identifier order, records its SHA-256 checksum,
and fails startup on checksum drift or migration failure. `npm run
ledger:migrate` invokes the same runner for an explicit deployment step; it is
safe to run before startup but is not a competing migration system.

1. Install dependencies with `npm ci`.
2. Configure `DATABASE_URL`, `SEED_PASSWORD` (production),
   `QUOTE_TTL_SECONDS`, `RATE_BOARD_MAX_AGE_SECONDS`, and
   `QUOTE_OVERRIDE_MAX_DEVIATION`.
3. Run `npm run ledger:migrate` if an explicit preflight is desired.
4. Run `npm run ledger:seed` only for an empty demo or staging database.
5. Start the application; startup verifies the tracked migration ledger.
6. Check `GET /api/health`, then run rate sync and a scoped quote smoke test.

The Canadian pilot requires CAD to be exactly one exchange leg. It is current
configuration, not a universal CurrencyDesk rule. `feeCad` is separate CAD
tender and the quote-post endpoint requires `purpose` and `sourceOfFunds`.
Historical quote transactions retain their frozen rate-board, market-snapshot,
market-mid, source-type, and override lineage.

(The "next slices" that used to be listed here all shipped: workspace
provisioning is `server/src/ledger/provisioning.ts` + migration 004, and the
browser flow posts frozen quotes through `/api/quotes`. Production
market-data assurance and an approved override policy remain open — see
`docs/ROAD_TO_DEPLOYMENT.md`.)

## Stripe billing

Subscriptions use Stripe-hosted Checkout, Stripe Tax and the Stripe Customer
Portal; card details never reach this server. Signed webhooks project Stripe
customers, subscriptions and invoices into the local database, and only a
paid Stripe invoice updates a paid tenant plan. See
[`docs/STRIPE_BILLING.md`](../docs/STRIPE_BILLING.md) for the required test and
live dashboard setup.
