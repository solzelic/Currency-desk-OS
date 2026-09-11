# PROJECT_STATE — what is true now

This document describes the present. It is not a changelog (git history and
PRs are the changelog) and not a roadmap essay. Every PR either updates it or
explicitly records that it was reviewed and needed no change — CI enforces
this (`scripts/check-repository-governance.mjs`).

## What CurrencyDesk is today

A multi-tenant SaaS operating system for currency-exchange houses. One
sign-in gives a desk its rate board, ledger, quotes, transfers, cheque
cashing, clients/KYC, compliance thresholds, alerts and filing records
(a filing is sealed and recorded in the ledger; submission to the regulator
is not automated), till/vault cash, and reports. CurrencyDesk also hosts
each customer's public storefront (live rates, converter, SMS rate quotes)
on their own domain, and runs a growth pipeline (lead research + outbound
calling) for its own sales funnel.
Deployed as **one Render web service** (`render.yaml`), auto-deploying `main`.

## Current product milestone — Shop-Ready Core v1

One shop, one full operating loop, provable end to end: an approved operator
can go from Early Access → approval → onboarding → configured desk and rates
→ open till → quote and post FX transactions → acknowledge manual KYC
verification when the system flags it → receive internal compliance
alerts/work items → have the authoritative ledger, till and audit trail
update correctly → reconcile and close the day.

Automated KYC-provider integration, SMS delivery, calling-agent automation,
external rate publishing and other external integrations are useful next
layers — they are not blockers for proving this core loop.

## Current architecture (major components only)

- **Server** — Fastify + Drizzle, `server/src/`. API plus all static serving
  from the repo root behind an allow-list. Embedded PGlite in dev/test,
  Postgres in production; boot applies DDL + checksummed migrations.
- **The ledger** — server-side Postgres, `server/src/ledger/` + migrations.
  Append-only; the single authoritative book.
- **The OS** — buildless React in `os-src/` + shell `CurrencyDesk OS.html`,
  compiled ahead of time to `web/app/` by `scripts/build-os.mjs`.
  Production `/login` and `/app` serve that compiled shell
  (`/web/app/os.js`). `STATIC_INDEX` names the uncompiled shell as a
  fallback only; it does not override compiled output.
- **Admin panel** — `admin.html`, compiled to `web/app/admin.*`.
- **Marketing site** — generated into `web/` from `design/site/*.dc.html`.
- **Onboarding** — `web/onboarding.html`, generated from
  `design/onboarding/currencydesk-onboarding.html`.
- **Customer storefront** — `YorkFX/`, served at `/sites/yorkfx` and via
  customer domains. Customer pages are plain HTML and their own scripts;
  they do not load unpkg, Babel, or `react.development`. The design-time
  tweaks panel stays in the repo and is not referenced from those pages.

Full map, routes and build commands: `docs/REPOSITORY_MAP.md`.

## What is authoritative (where truth lives)

| Concern | Authority |
| --- | --- |
| Financial ledger — every balance, movement, P&L | Server Postgres ledger (`server/src/ledger/`). One book. The browser renders cash, never computes it |
| Customers / KYC files | Server: `desk_clients` (+ documents/images tables). `ledger_customers` is the ledger-side counterparty record — deliberately distinct |
| Published rate board | Server (`/api/rates`, publish cycle). `localStorage` on the storefront is a cache, never a second book |
| Tenant / session identity | Server sessions + CD-IDs; the server mints all identifiers |
| Frontend truth | Sources: `os-src/`, `design/` (site, onboarding, emails), the root shells. `web/` and `web/app/` are generated output — never edited directly, CI-gated for staleness |

## Production/build surfaces

`marketing site` (`/`) · `OS` (`/app`, `/login`) · `admin` (`/admin`) ·
`onboarding` (`/onboarding/:code`) · `customer storefront` (`/sites/yorkfx`)
· `server/API` (`/api/*`).

## Current active work

- The compiled-OS production slice is closed on `main` (`90a3890`, #43).
  Live `/login` and `/app` serve `/web/app/os.js`. Re-verified 2026-08-17
  at `f31cf21` (#44).
- **Engineering standards audit** of `main` at `f31cf21` is recorded in
  `docs/STANDARDS_AUDIT.md` (2026-09-04). Docs only — no product slice
  opened at that stamp. Issue **#31** (one-shot platform-admin bootstrap)
  has since landed in code. Audit Slice D (honest public health) has
  also landed: `GET /api/health` now performs a trivial database read.
  Audit Slice E (quote door matches the book) has landed:
  `POST /api/quotes` validates currency as an uppercase ISO-style
  3-letter code, not a four-way CAD/USD/EUR/GBP enum. A desk that can
  float PHP can quote it. Pack pair rules and `assertTradeable` are
  unchanged.
  Audit Slice F (storefront holds are decimal) has landed:
  `rate_quotes` amounts/rates and `rate_boards` margins are
  `numeric` (money 2dp, rates/margins 12dp). The SMS quote path and
  the public board display price with `decimal.js`, once. jsonb board
  mids remain JS numbers — parked with the rest of that audit finding.

- **Product-demo desk** — York FX can be opened as a lived-in shop for a
  meeting. Staff id `demo` is created on that tenant if missing; the
  password is stamped only from `DEMO_STAFF_BOOTSTRAP` and is never
  overwritten on a later boot. `DEMO_POPULATE=1` posts a small already-
  saved history through the real quote / ledger / client-record
  services (CAD↔USD/EUR), only when `tnt-yorkfx` still has
  `siteSlug=yorkfx`. Login is `/login` → `/app`, not `/admin`. How to
  run it: `docs/DEMO_DESK.md`.

- **PR #30** — caller-safe lead dossier (growth pipeline). Still open.
  Not merge-ready: conflicts with `main` (`docs/HANDOFF_GROWTH_PIPELINE.md`
  was deleted in #40), and its CI is from 2026-08-06 (pre-governance).
  Outside the locked compiled-OS slice. The audit recommends park/close.

The Phase 1 repository cleanup is complete: governance, the security
cherry-pick, deterministic deletions, and documentation consolidation have
all landed. The nine unreferenced YorkFX media files rated LOW-MED were
deliberately retained until external hot-linking can be ruled out.

## Known high-priority engineering risks (unresolved)

1. **Platform MFA absent** (issue #33) — no TOTP/MFA on the cross-tenant
   admin console.
2. **Resend API key rotation** (issue #32) — the key passed through chat;
   rotation cannot be verified from the repo. Open until confirmed rotated.

Issue **#34** (multi-till/workspace resolution) is closed in code: an
unscoped ledger, quote or client-records call uses the workspace stamped
on the session (first till at the user's home branch at sign-in; updated
by `POST /api/ledger/till-selection`). `x-workspace-id` still names a
till for that request and is SCOPE_DENIED when out of scope. Adding a
till no longer denies existing callers. The day-at-the-desk seam spec
trades on its own till and no longer needs a `zz-` filename prefix.

Issue **#31** (`PLATFORM_ADMIN_BOOTSTRAP` re-set the operator password on
every boot) is closed in code: `ensurePlatformAdmin` creates a missing
account and never overwrites `passwordHash` / `mustChangePassword` /
`passwordUpdatedAt`. The env var should still be removed from Render after
first sign-in so the plaintext is not left in the host environment.

Public `GET /api/health` is no longer process-alive only. It runs the same
kind of trivial tenant read as the admin dashboard's database check
(`server/src/platform/health.ts`) and answers **503** `{ ok: false,
error: "database" }` when that read fails. Render `healthCheckPath` still
points at `/api/health`. Free-tier sleep after idle is unchanged — that
is a hosting step, not this probe. `/api/admin/health` remains the
authenticated narrative dashboard.

## Next engineering priorities (ordered)

1. Platform MFA (issue #33).
2. The Shop-Ready Core walkthrough — prove the milestone loop end to end.

## Last reviewed

**2026-09-11**, product-demo desk on York FX: staff id `demo` (one-shot
`DEMO_STAFF_BOOTSTRAP`) and opt-in `DEMO_POPULATE=1` activity seeder.
Posted through the existing ledger/quote/client services; other tenants
are out of scope. `docs/DEMO_DESK.md`.

Prior stamp **2026-09-09**, storefront SMS holds and rate-board margins are
`numeric`; the public quote path uses Decimal (audit Slice F). JSON
still returns numbers so the storefront `typeof === 'number'` contract
is unchanged. Twilio delivery is unchanged.

Prior stamp **2026-09-09**, `POST /api/quotes` accepts any valid ISO-style currency
code (uppercase 3 letters). The four-way CAD/USD/EUR/GBP enum on
`createBody` is gone; pair and desk-set policy stay in the quote
service. Audit Slice E.

Prior stamp **2026-09-09**, multi-till/workspace resolution (#34): unscoped money
routes use the session workspace rather than "the only workspace at this
branch". The day-at-the-desk seam spec runs in normal order on its own
till. Public `GET /api/health` still pings the database (trivial tenant
read) and returns 503 when that read fails.

Prior stamp **2026-09-09**, `PLATFORM_ADMIN_BOOTSTRAP` is one-shot (`ensurePlatformAdmin`
creates if missing; never overwrites an existing operator password). Issue
#31. Render should still drop the env var after first sign-in.

Prior stamp **2026-09-04**, Engineering standards audit of `main` at
`f31cf21` (#44). Scorecard, residual-issue verification, and proposed
two-line slice end states: `docs/STANDARDS_AUDIT.md`. No product behaviour
changed in that audit.

Prior stamp **2026-08-17** (`90a3890`, #43; recorded on `main` by #44):
live `/login` and `/app` serve `/web/app/os.js` with no unpkg, Babel, or
`react.development`. No must-fix inside the locked compiled-OS slice.
Residual, not blocking: the uncompiled editor shells remain fetchable at
`/CurrencyDesk OS.html` and `/admin.html`; `/onboarding` still lists unpkg
React production URLs in its bundler template. Neither is a product-route
regression. Review this stamp — and every section above — whenever a PR
changes what is true.
