# PROJECT_STATE — what is true now

This document describes the present. It is not a changelog (git history and
PRs are the changelog) and not a roadmap essay. Every PR either updates it or
explicitly records that it was reviewed and needed no change — CI enforces
this (`scripts/check-repository-governance.mjs`).

## What CurrencyDesk is today

A multi-tenant SaaS operating system for currency-exchange houses. One
sign-in gives a desk its rate board, ledger, quotes, transfers, cheque
cashing, clients/KYC, compliance thresholds and filings, till/vault cash,
and reports. CurrencyDesk also hosts each customer's public storefront
(live rates, converter, SMS quotes) on their own domain, and runs a growth
pipeline (lead research + outbound calling) for its own sales funnel.
Deployed as **one Render web service** (`render.yaml`), auto-deploying `main`.

## Current architecture (major components only)

- **Server** — Fastify + Drizzle, `server/src/`. API plus all static serving
  from the repo root behind an allow-list. Embedded PGlite in dev/test,
  Postgres in production; boot applies DDL + checksummed migrations.
- **The ledger** — server-side Postgres, `server/src/ledger/` + migrations.
  Append-only; the single authoritative book.
- **The OS** — buildless React in `os-src/` + shell `CurrencyDesk OS.html`,
  compiled ahead of time to `web/app/` by `scripts/build-os.mjs`.
- **Admin panel** — `admin.html`, compiled to `web/app/admin.*`.
- **Marketing site** — generated into `web/` from `design/site/*.dc.html`.
- **Onboarding** — generated `web/onboarding.html` from the root design bundle.
- **Customer storefront** — `YorkFX/`, served at `/sites/yorkfx` and via
  customer domains.

Full map, routes and build commands: `docs/REPOSITORY_MAP.md`.

## What is authoritative (where truth lives)

| Concern | Authority |
| --- | --- |
| Financial ledger — every balance, movement, P&L | Server Postgres ledger (`server/src/ledger/`). One book. The browser renders cash, never computes it |
| Customers / KYC files | Server: `desk_clients` (+ documents/images tables). `ledger_customers` is the ledger-side counterparty record — deliberately distinct |
| Published rate board | Server (`/api/rates`, publish cycle). `localStorage` on the storefront is a cache, never a second book |
| Tenant / session identity | Server sessions + CD-IDs; the server mints all identifiers |
| Frontend truth | Sources: `os-src/`, `design/site/`, root shells. `web/` and `web/app/` are generated output — never edited directly, CI-gated for staleness |

## Production/build surfaces

`marketing site` (`/`) · `OS` (`/app`, `/login`) · `admin` (`/admin`) ·
`onboarding` (`/onboarding/:code`) · `customer storefront` (`/sites/yorkfx`)
· `server/API` (`/api/*`).

## Current active work

- **PR #30** — caller-safe lead dossier (growth pipeline). Open, under normal review.
- **Repository governance** — this branch (`chore/repository-governance`): AI
  instruction system, living docs, PR governance CI, full seam suite in CI.
- **Queued next**: cherry-pick of the two unmerged security fixes from
  `claude/currencydesk-onboarding-completion-ls2i74` @ `cee9c74` (fake
  `000000` two-step screen removal; designed sign-in email), then the staged
  cleanup PRs from the Phase 1 audit (`docs/REPO_CONSOLIDATION_PHASE1.md` on
  the audit branch).

## Known high-priority engineering risks (unresolved)

1. **Fake two-step screen ships in the OS bundle** — `os-src/cdos-os.jsx`
   still compiles a simulated 2FA screen with hardcoded `000000`. Fix exists
   unmerged on `cee9c74`; cherry-pick is queued (see Active work).
2. **Platform MFA absent** (issue #33) — no TOTP/MFA on the cross-tenant
   admin console.
3. **`PLATFORM_ADMIN_BOOTSTRAP` re-sets the operator password on every boot**
   (issue #31) while the env var is set (`server/src/admin-bootstrap.ts`) —
   safe only if the var is removed after first sign-in; nothing enforces that.
4. **Resend API key rotation** (issue #32) — the key passed through chat;
   rotation cannot be verified from the repo. Open until confirmed rotated.
5. **Multi-till/workspace resolution defect** (issue #34) — several routes
   resolve a request's till as "the only workspace at this branch" and deny
   callers without `x-workspace-id` once a second workspace exists. Makes
   seam-test order load-bearing (`zz-` prefix workaround).
6. **YorkFX storefront loads design tooling in production** (issue #35) —
   all five customer-facing pages pull React dev builds + Babel from unpkg
   for the tweaks panel, and `YorkFX/image-slot.js` 404s on a state file
   every load.
7. **Seam suite in CI** — being fixed by the governance branch; until it
   merges, the browser/financial gate in CI runs only 3 of 17 specs.

## Next engineering priorities (ordered)

1. Merge repository governance (this branch) — CI then runs the full seam suite.
2. Cherry-pick the `cee9c74` security fixes as `security/remove-fake-otp-screen`.
3. Cleanup PR 1 — deterministic low-risk deletions from the Phase 1 audit.
4. Documentation consolidation (Phase 1 audit §H).
5. Fix the multi-till resolution defect (issue #34), then remove the `zz-` workaround.
6. Platform MFA (issue #33).

## Last reviewed

**2026-08-14**, against `main` = `6704e856` ("Gate lead research on business
identity (#29)"). Review this stamp — and every section above — whenever a PR
changes what is true.
