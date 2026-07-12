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

## Next slices

1. Ledger posting API (immutable transactions + audit trail)
2. Customers / KYC
3. Rates service (live provider → published board)
