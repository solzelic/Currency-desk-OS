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
  Live `/login` and `/app` serve `/web/app/os.js`. Re-verified 2026-08-17.
- **PR #30** — caller-safe lead dossier (growth pipeline). Still open.
  Not merge-ready: conflicts with `main` (`docs/HANDOFF_GROWTH_PIPELINE.md`
  was deleted in #40), and its CI is from 2026-08-06 (pre-governance).
  Outside the locked compiled-OS slice.

The Phase 1 repository cleanup is complete: governance, the security
cherry-pick, deterministic deletions, and documentation consolidation have
all landed. The nine unreferenced YorkFX media files rated LOW-MED were
deliberately retained until external hot-linking can be ruled out.

## Known high-priority engineering risks (unresolved)

1. **Platform MFA absent** (issue #33) — no TOTP/MFA on the cross-tenant
   admin console.
2. **`PLATFORM_ADMIN_BOOTSTRAP` re-sets the operator password on every boot**
   (issue #31) while the env var is set (`server/src/admin-bootstrap.ts`) —
   safe only if the var is removed after first sign-in; nothing enforces that.
3. **Resend API key rotation** (issue #32) — the key passed through chat;
   rotation cannot be verified from the repo. Open until confirmed rotated.
4. **Multi-till/workspace resolution defect** (issue #34) — several routes
   resolve a request's till as "the only workspace at this branch" and deny
   callers without `x-workspace-id` once a second workspace exists. Makes
   seam-test order load-bearing (`zz-` prefix workaround).

## Next engineering priorities (ordered)

1. Fix the multi-till resolution defect (issue #34), then remove the `zz-` workaround.
2. Platform MFA (issue #33).
3. The Shop-Ready Core walkthrough — prove the milestone loop end to end.

## Last reviewed

**2026-08-17**, code review of `main` at `90a3890` (#43) and open PR #30.
Live `/login` and `/app` serve `/web/app/os.js` with no unpkg, Babel, or
`react.development`. No must-fix inside the locked compiled-OS slice.
Residual, not blocking: the uncompiled editor shells remain fetchable at
`/CurrencyDesk OS.html` and `/admin.html`; `/onboarding` still lists unpkg
React production URLs in its bundler template. Neither is a product-route
regression. Review this stamp — and every section above — whenever a PR
changes what is true.
