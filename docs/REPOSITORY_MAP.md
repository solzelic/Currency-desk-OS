# REPOSITORY_MAP — what runs, where it lives, how it builds

The five-minute orientation. Verified against the running configuration
(`render.yaml`, `server/src/app.ts`, `server/src/sites.ts`, CI workflows).
If a PR makes this document wrong, that PR updates it — CI checks
(`scripts/check-repository-governance.mjs`).

## The shape of production

One Render web service: the Fastify server serves the API **and** every
static surface from the repository root (`STATIC_DIR=..`) behind an explicit
allow-list in `server/src/app.ts`. There is no bundler SPA; the frontends are
buildless React compiled ahead of time. Generated output is **committed** and
CI fails if it is stale — so a deploy always serves exactly what the sources
say.

## Directories

| Path | Role | Edit? |
| --- | --- | --- |
| `server/src/` | Fastify + Drizzle backend; ledger under `server/src/ledger/` | ✅ |
| `server/src/db/migrations/` | checksummed SQL migrations — **immutable once merged** | add-only |
| `server/tests/` | vitest suites; `*.postgres.test.ts` need `TEST_DATABASE_URL` | ✅ |
| `os-src/` | the OS source: 28 `.jsx` domain files + `cdos-backend.js`, `cdos-persist.js`, `york-os.css` | ✅ |
| `CurrencyDesk OS.html` | OS shell — lists every `os-src` script; also the production fallback when `web/app` is absent | ✅ |
| `admin.html` | admin-panel shell (one inline Babel script) + production fallback | ✅ |
| `design/site/` | marketing design sources (`*.dc.html` + `support.js`, `image-slot.js`) | ✅ |
| `design/emails/` | email design reference | ✅ |
| `CurrencyDesk Onboarding.html` | onboarding design bundle (build input) | replaced by design exports |
| `web/` | **GENERATED** marketing site + onboarding + compiled apps (`web/app/`) + committed extracted assets (`fonts/`, `photos/`, `assets/`, `vendor/`) | ❌ never by hand |
| `YorkFX/` | customer storefront, served as-is at `/sites/yorkfx` | ✅ (it is production) |
| `yorkfx.css`, `yorkfx-converter.js` | shared storefront runtime at the repo root (served-path contract: `/sites/<file>`) | ✅ |
| `scripts/` | build + design-import tools + governance checks | ✅ |
| `tests/e2e/` | Playwright seam suite (drives the browser, then asks the ledger) | ✅ |
| `docs/` | durable engineering docs; `PROJECT_STATE.md` is the living one | ✅ |
| `render.yaml` | the deployment: build command, env contract, routes | ✅ carefully |

## Source → generated output

| Source | Command | Output |
| --- | --- | --- |
| `design/site/*.dc.html` | `npm run build:site` | `web/*.html`, `web/support.js`, `web/image-slot.js`, `web/vendor/` |
| `CurrencyDesk Onboarding.html` | `npm run build:onboarding` (also runs on Render deploy) | `web/onboarding.html` |
| `CurrencyDesk OS.html` + `os-src/` | `npm run build:os` | `web/app/index.html`, `web/app/os.js`, `web/app/tw.css` |
| `admin.html` | `npm run build:os` | `web/app/admin.html`, `web/app/admin.js` |
| designer "standalone" export | `scripts/extract-design-assets.mjs` (occasional) | `web/fonts/`, `web/photos/`, `web/assets/` |

`npm run build` runs all three build steps. After any source edit, rebuild and
commit the generated output — CI diffs `web/` against a fresh build.

## Route map

| Route | Serves |
| --- | --- |
| `/` (`/d`, `/m`) | marketing site — desktop / phone design by user agent |
| `/signup` | Early Access application (`web/early-access.html`) |
| `/login`, `/app` | the OS — compiled `web/app/index.html` (fallback: the root shell) |
| `/admin` | the admin panel — compiled `web/app/admin.html` |
| `/onboarding/*` | invite-code onboarding (`web/onboarding.html`; code read from the path) |
| `/legal` `/faq` `/compliance` `/contact` | generated standalone pages |
| `/sites/yorkfx/*` | the customer storefront (`YorkFX/`); customer domains rewrite here via Host header |
| `/YorkFX/*` | storefront files on the root allow-list (the OS embeds the Rate Board in an iframe from here) |
| `/api/*` | the API. Ledger, quotes and client-records routes register **only when a database URL is configured** |

## Databases

- App tables: Drizzle; embedded PGlite (dev/test) or Postgres (`DATABASE_URL`).
  Boot applies `DDL` + `runMigrations` — a fresh database self-provisions.
- Ledger tables: raw SQL — `server/src/ledger/migration.sql` registered as
  migration `001_ledger`, then `server/src/db/migrations/002…`. Append-only
  book. Invariants: `docs/CASH_OWNERSHIP_INVARIANTS.md`.
- Adding a migration touches **three places**: the SQL file, the list in
  `server/src/db/migrations.ts`, and (for Drizzle-managed tables) the `DDL`
  constant in `server/src/db/index.ts` + `server/src/db/schema.ts`.

## Test commands

```bash
npm run check:parse                     # every browser script parses
cd server && npm run typecheck && npm test          # server suite (embedded PGlite)
TEST_DATABASE_URL=postgres://…/freshdb npm test     # + the 22 Postgres invariant suites
SEAM_DATABASE_URL=postgres://…/freshdb npm run test:e2e   # full browser↔ledger seam suite
```

Use a **fresh disposable database per full run** — suites intentionally leave
ledger state behind. Without `SEAM_DATABASE_URL` the e2e server has no ledger
and 13 of 17 specs skip; CI runs the full suite with an ephemeral Postgres
(`.github/workflows/browser.yml`, seam job) and fails if a seam spec skips.
`tests/e2e/zz-a-day-at-the-desk.spec.ts` is the deployment gate; its `zz-`
prefix is a documented ordering workaround for the multi-till defect — keep it
until that defect is fixed.

## Where new work normally lives

- API/business logic → `server/src/<domain>/` (routes registered in `app.ts`)
- Schema → a **new** migration (never edit an old one)
- OS screens/behaviour → `os-src/cdos-<domain>.jsx`, then `npm run build:os`
- Marketing/site content → `design/site/`, then `npm run build:site`
- Storefront → `YorkFX/`
- Tests beside their layer: `server/tests/` or `tests/e2e/<behaviour>.spec.ts`
- Durable knowledge → the matching `docs/` file; current truth → `docs/PROJECT_STATE.md`

## Glossary (server-canonical vocabulary)

- **desk** = the product word for a **tenant** (the infrastructure word). Same thing, two registers.
- **workspace** = the ledger's scoping unit (`x-workspace-id`); **till** = the physical till a workspace fronts; **drawer** = the cash in an open till session. Three different things.
- **`desk_clients`** = the KYC client file; **`ledger_customers`** = the ledger counterparty. Deliberately distinct tables.
- **enquiry** → **application** → **lead**: stages of one funnel, not synonyms.
- **transaction** is the canonical stored noun; the UI says **deal** (`deal_kind` is a real column).

## Files that must never be edited directly

Everything under `web/` (including `web/app/`) — generated or extracted, and
CI-diffed against a fresh build. Migration files after merge. That is the
whole list; everything else is source.
