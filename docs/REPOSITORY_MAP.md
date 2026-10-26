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
| `os-src/` | the OS source: domain `.jsx` screens, `cdos-backend.js`, `cdos-persist.js`, `cdos-tour.js` (first-run tour), `york-os.css` | ✅ |
| `shared/` | plain scripts the server `require`s. The shell loads `id-document-types.js` (the ID-type catalogue), `counter-cash.js` (which legs of a deal are cash), `rolling-24h.js` (the rolling 24 hours before a deal), and `lctr-reversal.js` (which reversal still counts toward an LCTR). `str-role.js` is who may see an STR and who may see the structuring watch. The server requires it. The shell does not load it. `cheque-day-closed.js` is the closed-day next step and the line "The closed day stays as it was." The server puts both on the 422 and the desk prints those fields. The shell does not load it, and it is not served | ✅ |
| `CurrencyDesk OS.html` | OS shell. Lists every `os-src` script, `shared/id-document-types.js`, `shared/counter-cash.js`, `shared/rolling-24h.js`, and `shared/lctr-reversal.js`. Also the production fallback when `web/app` is absent | ✅ |
| `admin.html` | admin-panel shell (one inline Babel script) + production fallback | ✅ |
| `design/site/` | marketing design sources (`*.dc.html` + `support.js`, `image-slot.js`) | ✅ |
| `design/emails/` | email design reference | ✅ |
| `design/kyc-handoff/` | KYC design handoff: brand tokens, motion spec, verification-states reference | ✅ |
| `design/onboarding/` | onboarding design bundle (build input, `currencydesk-onboarding.html`) | replaced by design exports |
| `web/` | **GENERATED** marketing site + onboarding + compiled apps (`web/app/`) + committed extracted assets (`fonts/`, `photos/`, `assets/`, `vendor/`) | ❌ never by hand |
| `YorkFX/` | customer storefront, served as-is at `/sites/yorkfx`. Customer HTML does not load unpkg, Babel, or React dev builds. The Rate Board here is also the OS's board editor (iframe); its published boards live under `yorkfx_*` localStorage keys — moving the board into the product needs a key migration or published boards orphan | ✅ (it is production) |
| `yorkfx.css`, `yorkfx-converter.js` | shared storefront runtime at the repo root (served-path contract: `/sites/<file>`) | ✅ |
| `scripts/` | build + design-import tools + governance checks | ✅ |
| `tests/e2e/` | Playwright seam suite (drives the browser, then asks the ledger) | ✅ |
| `docs/` | durable engineering docs; `PROJECT_STATE.md` is the living one. Product-demo sit-down: `docs/DEMO_DESK.md` | ✅ |
| `render.yaml` | the deployment: build command, env contract, routes | ✅ carefully |

## Source → generated output

| Source | Command | Output |
| --- | --- | --- |
| `design/site/*.dc.html` | `npm run build:site` | `web/*.html`, `web/support.js`, `web/image-slot.js`, `web/vendor/` |
| `design/onboarding/currencydesk-onboarding.html` | `npm run build:onboarding` (also runs on Render deploy) | `web/onboarding.html` |
| `CurrencyDesk OS.html` + `os-src/` + `shared/` | `npm run build:os` | `web/app/index.html`, `web/app/os.js`, `web/app/tw.css` |
| `admin.html` | `npm run build:os` | `web/app/admin.html`, `web/app/admin.js` |
| designer "standalone" export | `scripts/extract-design-assets.mjs` (occasional) | `web/fonts/`, `web/photos/`, `web/assets/` |

`npm run build` runs all three build steps. After any source edit, rebuild and
commit the generated output — CI diffs `web/` against a fresh build.

## Route map

| Route | Serves |
| --- | --- |
| `/` (`/d`, `/m`) | marketing site — desktop / phone design by user agent |
| `/signup` | Early Access application (`web/early-access.html`) |
| `/login`, `/app` | the OS — compiled `web/app/index.html` + `/web/app/os.js`. `STATIC_INDEX` names the uncompiled root shell as a fallback only; compiled output wins when present |
| `/admin` | the admin panel — compiled `web/app/admin.html` |
| `/onboarding/*` | invite-code onboarding (`web/onboarding.html`; code read from the path) |
| `/legal` `/faq` `/compliance` `/contact` | generated standalone pages |
| `/sites/yorkfx/*` | the customer storefront (`YorkFX/`); customer domains rewrite here via Host header |
| `/YorkFX/*` | storefront files on the root allow-list (the OS embeds the Rate Board in an iframe from here) |
| `/api/health` | public probe (no auth). Trivial database read; **200** if it succeeds, **503** `{ ok: false, error: "database" }` if it does not. The body adds `commit` (7-character `RENDER_GIT_COMMIT`, or `unknown`) and `lastMigration` (newest `schema_migrations` id, or null when that read fails, including a connect failure). On Postgres that read sets `statement_timeout` to 1000 ms, so the server cancels it and frees the connection. Render `healthCheckPath`. Narrative checks stay at authenticated `/api/admin/health` |
| `GET /api/staging/signin`, `POST /api/staging/enter` | Registered only when `stagingDoorOpen()` is true (`STAGING` exactly `1`). Each request calls `stagingDoorOpen` with the headers, which checks the Host through `isStagingRuntime` and ignores `x-forwarded-host`, and requires the demo shop `tnt-yorkfx`. A live host is 404. The flag is not in `render.yaml`. |
| `POST /api/staging/fresh-shop` | Registered only when `stagingDoorOpen()` is true (`STAGING` exactly `1`). Each request calls `stagingDoorOpen` on the Host header. `x-forwarded-host` and `Forwarded` are not read. A live host is 404. The body is ignored. The handler holds a pending signup (`stg-<8 hex>`, `owner+<id>@staging.invalid`, trial, no regulator) and returns the 6-digit code and a one-time password once. Only hashes are stored. Nothing is emailed or logged. `POST /api/signup/verify` creates the shop, sets `is_test_shop`, and writes `staging.fresh_shop_created`. Eight calls from one address in an hour; the next is 429. The count is in memory for the process. It does not write `tnt-yorkfx`. The flag is not in `render.yaml`. |
| `/api/*` | the API. Ledger, quotes and client-records routes register **only when a database URL is configured** |

The root allow-list in `server/src/app.ts` still names `CurrencyDesk OS.html`, `admin.html`, and `/os-src/` so a deploy that skipped `npm run build:os` can boot the hand-written shells. When `web/app/index.html` is in `STATIC_DIR`, a direct fetch of `/CurrencyDesk OS.html` or of anything under `/os-src/` except `/os-src/york-os.css` is a 404, including a browser navigation. It is not answered with the marketing page. When `web/app/admin.html` is present, `/admin.html` is a 404 the same way. `/shared/id-document-types.js`, `/shared/counter-cash.js`, `/shared/rolling-24h.js`, and `/shared/lctr-reversal.js` are on the list for the uncompiled shell and are a 404 with `os-src/` once the compiled OS shell is present. Nothing else under `shared/` is served. The compiled desk links `/os-src/york-os.css`, so that stylesheet stays public either way. `/assets/`, `/YorkFX/`, `/web/`, `/yorkfx.css`, and `/yorkfx-converter.js` are unchanged. The two shells are gated separately: a half-built `web/app` hides only the file whose compiled replacement is on disk. When `NODE_ENV` is `production`, a missing `web/app/index.html` logs that the uncompiled shell and `os-src` are public, and a missing `web/app/admin.html` logs that the uncompiled admin shell is public. The admin warning does not mention `os-src`. The same boot logs nothing when `NODE_ENV` is unset or `test`. The fallback itself stays, so a skipped build does not take the desk down.

## Databases

- App tables: Drizzle; embedded PGlite (dev/test) or Postgres (`DATABASE_URL`).
  Boot applies `DDL` + `runMigrations`. A fresh database self-provisions.
  `runMigrations` logs `opening database` before its first query and one
  `migration applied: <id>` line for each migration it applies. A later
  run logs no applied line for a migration already stored.
- Ledger tables: raw SQL — `server/src/ledger/migration.sql` registered as
  migration `001_ledger`, then `server/src/db/migrations/002…`. Append-only
  book. Invariants: `docs/CASH_OWNERSHIP_INVARIANTS.md`.
- Adding a migration touches **three places**: the SQL file, the list in
  `server/src/db/migrations.ts`, and (for Drizzle-managed tables) the `DDL`
  constant in `server/src/db/index.ts` + `server/src/db/schema.ts`.
- Migration `033_serbia_pack` seeds `pack-rs-v1` and does not edit an
  older pack. It lets `jurisdiction_packs.aggregation_hours` be null
  (null means the deals are not added together), adds
  `branches.airside_or_casino` (also in the Drizzle schema and the boot
  DDL, because PGlite does not run the SQL migrations), and adds
  `identity_number`, `note_serials`, and `receipt_facts` on
  `ledger_transactions`. It also adds `nbs_middle_rates` (dinars per
  1 euro for one Belgrade date; posting reads it and does not fetch
  the bank) and `compliance_threshold_rate_source` (`nbs_middle` or
  `none`). 033 is on main. 027 and 030 are still open drafts. The rule
  text is `docs/SERBIA_PACK.md`.
- Migration `035_pack_gb_v2` inserts the current United Kingdom pack.
  It does not edit `pack-gb-v1`. 029, 031, 033, and 034 are already on
  main, so 035 stays. The rule itself is `docs/UK_PACK.md`.
- Migration `036_pack_ae_v2` inserts the current United Arab Emirates
  pack. It does not edit `pack-ae-v1`. 029, 031, 033, 034, and 035 are
  already on main, so 036 stays. The rule itself is `docs/UAE_PACK.md`.
- Migration `037_pack_in_v1` inserts the first India pack. It does not
  move a desk that is already open. `aggregation_hours` is null. The
  calendar month lives on the cash-report row. 029, 031, 033, 034, 035,
  and 036 are already on main, so 037 stays. The rule text is
  `docs/INDIA_PACK.md`.
- Migration `038_pack_ph_v1` inserts the first Philippines pack. It
  does not move a desk that is already open. `aggregation_hours` is
  null. The banking day lives on the covered-transaction row. 029, 031,
  033, 034, 035, 036, and 037 are already on main, so 038 stays. 027
  and 030 are still open drafts. The rule text is
  `docs/PHILIPPINES_PACK.md`.
- Migration `039_live_cheque_paper` adds a unique index so one branch
  cannot hold two live cheques with the same number, payer, and bank.
  038 is the last migration on main, so this file is 039. A book that
  already holds a duplicate stays bootable: the older held copy is
  left out of the index (`paper_guard` false) and the newest copy is
  the row the index watches. The rule is `docs/CHEQUE_CASHING.md`.
- Migration `040_till_balance_generation` keeps one generation per till
  and bumps it when that drawer's cash changes. A close names the
  generation it counted against. 039 is on main, so this file is 040.
- Migration `044_signin_rate_limit` stores shop sign-in failure counts
  and the emailed-code marker (the password step has to have passed
  before a code is checked). Both tables are also in the boot DDL,
  because PGlite does not run the SQL migrations. 040 is on main.
  041 is claimed by open drafts #96, #110, #120, and #132, 042 by #130,
  and 043 by #138, so this file is 044. 027 and 030 are still open drafts.
- Migration `047_accepted_id_types` adds `legal_entities.accepted_id_types`
  (catalogue codes; NULL follows the pack) with a shape CHECK. The
  column is also in the boot DDL and the Drizzle schema. 046 is the last
  on main, so this file is 047. The pack defaults and locks are code,
  in `server/src/ledger/id-type-rules.ts`. The rule is
  `docs/CLIENT_RECORDS.md`, "Accepted IDs, per shop".
- Migration `048_till_count_stored_expected` adds
  `ledger_till_counts.stored_expected_amount`. It is the unrounded
  expected, saved next to the variance on a new count. Older rows stay
  NULL. The migration does not backfill them and does not recalculate
  `variance_amount`. The count row is already append-only, so the field
  cannot be updated. The variance on a new row is counted minus
  `roundTo` of that expected. The till balance is not rewritten. 047
  is the previous file, so this one is 048.
- Migration `050_idv_shop_config` adds `idv_shop_config`, one row per
  shop (the session legal entity): shop id, provider (default
  `persona`), API key reference (`PERSONA_API_KEY` or `PERSONA_API_KEY_<SHOP>`), template id, retention in days,
  and checks enabled (default false). 049 is `049_idv_inquiry_map`, already on main, so this file is 050. The
  table is also in the boot DDL and the Drizzle schema. `GET` and
  `PUT /api/settings/idv` are the owner's. Provider-specific field
  rules live under `server/src/idv/providers/`.
- Migration `051_idv_inquiry_status` adds `idv_inquiries.status` (default `starting`). 049 is the inquiry map, already on main. 050 is the shop config on the stack parent, so this file is 051. The column is also in the boot DDL because PGlite does not run SQL migrations. `POST /api/idv/start-check` reads `idv_shop_config`, takes the provider from the registry, and starts a sandbox check for the caller's shop, branch, and teller. The Persona adapter resolves the key from the row's name, or `PERSONA_API_KEY` when the name is empty, and uses the row's template id. A per-shop advisory lock covers the cap count and the insert.
- Migration `052_idv_credit_ledger` adds the append-only identity-check
  credit ledger `idv_credit_ledger`. The balance is the sum of the rows.
  A grant has no inquiry. The service accepts a whole number from 1 to 1000.
  The table check rejects zero, a negative amount, or a fraction. A reserve,
  a settle, and a release are one row per inquiry, and settle and release
  cannot both exist. Update, delete, and truncate raise. 049, 050, and 051 are on main, so this file is 052.
  `POST /api/idv/credits` is a platform administrator and only when
  `IDV_CREDIT_SANDBOX` is `1`. `GET /api/idv/credits` reads the caller's
  shop.   Neither route is a purchase.
- Migration `053_lctr_filing_flag` adds `ledger_filing_flags`, one row per filing and deal, with the actor and the time. The foreign key is `ON DELETE CASCADE`. A booking error on a deal already in a prepared or filed LCTR writes that row and does not update the filing row. The sentence is chosen when the flag is read. 052 is on main, so this file is 053.
- Migration `054_watch_customer_lock` defines
  `ledger_lock_watch_customer(tenant, entity, branch, customer)`.
  An insert into `ledger_reversals` calls it for the reversed deal.
  A new deal does not take the lock. 053 is on main, so this file is 054.
- Migration `056_tenant_test_shop` adds `tenants.is_test_shop`
  (`boolean not null default false`). The shared boot DDL does not
  add the column. Postgres adds it only here, and raises when a
  leftover column has any other shape. PGlite runs this same file
  after DDL, because PGlite does not run the SQL migrations. The
  Drizzle schema includes the column. Every existing shop stays
  false. A verified staging fresh shop sets it true. 055 is on main, so this file is 056.
  Issue #412.

## Test commands

```bash
npm run check:parse                     # every browser script parses
npm run check:sanctions                 # banned-name variants, then the built web/app/os.js
cd server && npm run typecheck && npm test          # server suite (embedded PGlite)
TEST_DATABASE_URL=postgres://…/freshdb npm test     # + the 41 *.postgres.test.ts suites
SEAM_DATABASE_URL=postgres://…/freshdb npm run test:e2e   # full browser↔ledger seam suite
```

Use a **fresh disposable database per full run** — suites intentionally leave
ledger state behind. Without `SEAM_DATABASE_URL` the e2e server has no ledger
and 28 of 40 spec files skip; CI runs the full suite with an ephemeral Postgres
(`.github/workflows/browser.yml`, `browser-seam` job) and fails if a seam spec skips.
`browser-validate` runs `npm run check:sanctions` after the OS build, so the
committed `web/app/os.js` cannot name a sanctions list.
`tests/e2e/a-day-at-the-desk.spec.ts` is the deployment gate. It trades on
its own till (opened through the product's add-till route) so file order
is not load-bearing.
`.github/workflows/civil-dates.yml` runs the sign-off day, the ID expiry,
the cheque dates, and the client record dates under `Asia/Jerusalem` and
`America/Toronto`. Formatting those days with `toISOString()` fails the
Jerusalem run. The desktop clock spec pins its browser zone itself.
The desk clock and the branch civil day live in `os-src/cdos-desk-time.js`.
`npm run check:parse` fails if an `os-src` screen grows a new `toLocaleTimeString`,
`toISOString().slice(0, 10)`, or `getHours` outside that file. `getHours` has
no baseline.

## Where new work normally lives

- API/business logic → `server/src/<domain>/` (routes registered in `app.ts`)
- Schema → a **new** migration (never edit an old one)
- OS screens/behaviour → `os-src/cdos-<domain>.jsx`, then `npm run build:os`
- Marketing/site content → `design/site/`, then `npm run build:site`
- Storefront → `YorkFX/`
- Tests beside their layer: `server/tests/` or `tests/e2e/<behaviour>.spec.ts`
- Durable knowledge → the matching `docs/` file; current truth → `docs/PROJECT_STATE.md`
- Product-demo desk (York FX `/login`, staff `demo`) → `server/src/demo-desk.ts`, opted in at boot from `server/src/index.ts` via `DEMO_STAFF_BOOTSTRAP` / `DEMO_POPULATE`. How to run it: `docs/DEMO_DESK.md`

## Glossary (server-canonical vocabulary)

- **desk** = the product word for a **tenant** (the infrastructure word). Same thing, two registers.
- **workspace** = the ledger's scoping unit (`x-workspace-id`); **till** = the physical till a workspace fronts; **drawer** = the cash in an open till session. Three different things.
- **`desk_clients`** = the KYC client file; **`ledger_customers`** = the ledger counterparty. Deliberately distinct tables.
- **enquiry** → **application** → **lead**: stages of one funnel, not synonyms.
- **transaction** is the canonical stored noun; the UI says **deal** (`deal_kind` is a real column).

## The four product files still at the repository root, and why

Everything else at the root is a standard project/config/governance file.
These four look out of place and are deliberately still there:

- `CurrencyDesk OS.html` — the OS shell you edit, and the fallback when
  `web/app/index.html` is absent. `render.yaml` still names it in
  `STATIC_INDEX`, but that variable is a fallback only: the server serves
  the compiled app whenever it is present, so a stale dashboard copy of
  the variable cannot put Babel back on `/login` or `/app`. While that
  compiled shell is on disk, fetching `/CurrencyDesk OS.html` itself is a
  404. Moving the file still needs the Render environment updated in the
  same motion.
- `admin.html` — the OS shell's twin (same build input, same fallback, same
  allow-list block). While `web/app/admin.html` is on disk, fetching
  `/admin.html` is a 404. It could move alone, but splitting the pair helps
  nobody; it moves in the same job as the OS shell.
- `yorkfx.css`, `yorkfx-converter.js` — served at **two public URLs each**
  (`/yorkfx*` for the app door, `/sites/yorkfx*` for the storefront door via
  the `../` references in every YorkFX page) on a live customer's site.
  The correct future home is inside `YorkFX/` (same-directory references fix
  both doors and delete the `sites.ts` special-case), but that changes
  customer-facing URLs — done deliberately, with cache/hot-link fallout
  considered, not overnight.

## Files that must never be edited directly

Everything under `web/` (including `web/app/`) — generated or extracted, and
CI-diffed against a fresh build. Migration files after merge. That is the
whole list; everything else is source.
