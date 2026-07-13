# CurrencyDesk Server

The backend for the TypeScript frontend (`src/`). First slice: **auth + tenancy**.

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

Staff belong to a tenant + legal entity + home branch, with `authorizedBranchIds` for cross-branch access. Roles are the same union as `src/domain/types.ts` (`teller` … `auditor`), so the frontend's `authorize()` logic and the server can never drift.

## Run

```sh
cd server
npm install
npm run dev          # http://127.0.0.1:8787, embedded DB, auto-seeded
```

Frontend dev (`npm run dev` at the repo root) proxies `/api` → `:8787`.

Demo accounts (any of `j.masri`, `r.haddad`, `a.singh`), password `yorkville`. **Demo only.**

## API

| Method | Path             | Description                              |
| ------ | ---------------- | ---------------------------------------- |
| POST   | /api/auth/login  | `{ staffId, password }` → session cookie |
| POST   | /api/auth/logout | revoke session                           |
| GET    | /api/auth/me     | current user + scope, 401 if none        |
| GET    | /api/health      | liveness                                 |

Login failures are uniform (`invalid_credentials`) to prevent staff-ID enumeration, and every attempt lands in `audit_events`.

## Test

```sh
npm run typecheck && npm test
```

Integration tests run the full HTTP app against an in-memory PGlite instance.

## Ledger posting (isolated local PostgreSQL)

```sh
# terminal 1: disposable PostgreSQL 16 cluster
initdb -D /private/tmp/cdos-postgres
pg_ctl -D /private/tmp/cdos-postgres -o "-p 54329" -l /private/tmp/cdos-postgres.log start
createdb -p 54329 currencydesk_ledger_test

# terminal 2: migrate and seed only the disposable database
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

On a real `DATABASE_URL`, the same idempotent ledger SQL migration is part of
the server's normal database bootstrap lifecycle. `ledger:migrate` remains a
convenience command for provisioning an isolated test database.

## Next slices

1. Ledger posting API (immutable transactions + audit trail)
2. Customers / KYC
3. Rates service (live provider → published board)
