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
| `os-src/` | the OS source: domain `.jsx` screens, `cdos-backend.js`, `cdos-persist.js`, `cdos-tour.js` (first-run tour), `york-os.css`. The Rates app is `cdos-rates.jsx` (header, Board, currency panel), `cdos-rates-site.jsx` (Website & window), `cdos-rates-pricing.jsx` (Pricing & rates), `cdos-rates-guard.jsx` (Guardrails) and `cdos-rates-stock.jsx` (Cost & stock, Record cash bought), with the shared board logic in `rates-board.js` | ✅ |
| `shared/` | plain scripts the server `require`s. The shell loads `id-document-types.js` (the ID-type catalogue), `counter-cash.js` (which legs of a deal are cash), `rolling-24h.js` (the rolling 24 hours before a deal), and `lctr-reversal.js` (which reversal still counts toward an LCTR). `str-role.js` is who may see an STR and who may see the structuring watch. The server requires it. The shell does not load it. `cheque-day-closed.js` is the closed-day next step and the line "The closed day stays as it was." The server puts both on the 422 and the desk prints those fields. The shell does not load it, and it is not served. `currency-face.js` is a currency's flag image (`assets/flags`) or emoji and its English name; the shell loads it, and it is served always (not only for the uncompiled shell) because the public rate page and window screens load it too | ✅ |
| `CurrencyDesk OS.html` | OS shell. Lists every `os-src` script, `shared/id-document-types.js`, `shared/counter-cash.js`, `shared/rolling-24h.js`, `shared/lctr-reversal.js`, and `shared/currency-face.js`. Also the production fallback when `web/app` is absent | ✅ |
| `admin.html` | admin-panel shell (one inline Babel script) + production fallback | ✅ |
| `design/site/` | marketing design sources (`*.dc.html` + `support.js`, `image-slot.js`) | ✅ |
| `design/emails/` | email design reference | ✅ |
| `design/kyc-handoff/` | KYC design handoff: brand tokens, motion spec, verification-states reference | ✅ |
| `design/onboarding/` | onboarding design bundle (build input, `currencydesk-onboarding.html`) | replaced by design exports |
| `design/onboarding/signup-v2.1/` | Sol's frozen sign-up v2.1 prototype, unchanged (`PROVENANCE.md`), plus `../signup-v2.1-{bridge,chapters,open,consent}.js` (hand-written: the page ⇄ real server) and `../signup-sso.html` | design file replaced only by a new export; the bridge is source |
| `web/` | **GENERATED** marketing site + onboarding + compiled apps (`web/app/`) + committed extracted assets (`fonts/`, `photos/`, `assets/`, `vendor/`) | ❌ never by hand |
| `YorkFX/` | customer storefront, served as-is at `/sites/yorkfx`. Customer HTML does not load unpkg, Babel, or React dev builds. The Rate Board here is also the OS's board editor (iframe); its published boards live under `yorkfx_*` localStorage keys — moving the board into the product needs a key migration or published boards orphan | ✅ (it is production) |
| `yorkfx.css`, `yorkfx-converter.js` | shared storefront runtime at the repo root (served-path contract: `/sites/<file>`) | ✅ |
| `scripts/` | build + design-import tools + governance checks; `capture-signup.cjs` / `signup-capture-measure.cjs` capture visible signup states, and `compare-signup-capture.mjs` retains every comparison difference | ✅ |
| `tests/e2e/` | Playwright seam suite (drives the browser, then asks the ledger) | ✅ |
| `docs/` | durable engineering docs; `PROJECT_STATE.md` is the living one. Product-demo sit-down: `docs/DEMO_DESK.md` | ✅ |
| `render.yaml` | the deployment: build command, env contract, routes | ✅ carefully |

## Source → generated output

| Source | Command | Output |
| --- | --- | --- |
| `design/site/*.dc.html` | `npm run build:site` | `web/*.html`, `web/support.js`, `web/image-slot.js`, `web/vendor/` |
| `design/onboarding/currencydesk-onboarding.html` | `npm run build:onboarding` (also runs on Render deploy) | `web/onboarding.html` |
| `design/onboarding/signup-v2.1/*` + `signup-v2.1-{bridge,chapters,open,consent,audio,tour}.js` + `signup-recordings/` + `signup-sso.html` | `npm run build:signup` (asserted patches, agreement hash checked, `scripts/signup-aot.mjs` compiles the template to React calls with pinned parse5) | `web/signup.html`, `web/app/signup.js`, `web/signup-sso.html`, `web/signup/{flags,shots,recordings}` |
| `CurrencyDesk OS.html` + `os-src/` + `shared/` | `npm run build:os` | `web/app/index.html`, `web/app/os.js`, `web/app/tw.css` |
| `admin.html` | `npm run build:os` | `web/app/admin.html`, `web/app/admin.js` |
| designer "standalone" export | `scripts/extract-design-assets.mjs` (occasional) | `web/fonts/`, `web/photos/`, `web/assets/` |

`npm run build` runs all three build steps. After any source edit, rebuild and
commit the generated output — CI diffs `web/` against a fresh build.

## Route map

| Route | Serves |
| --- | --- |
| `/` (`/d`, `/m`) | marketing site — desktop / phone design by user agent |
| `/signup` | Early Access application, v2.1 since 14 Nov (`web/early-access-v2.html`, the same page as `/early-access`); every "Get early access" on the site leads here. The old page (`web/early-access.html`) is still built but no route serves it. |
| `/early-access` | Early Access v2.1 (`web/early-access-v2.html`, built from `design/site/CurrencyDesk Early Access v2.dc.html`, a port of Sol's prototype with the server wired in; notes at the top of the source). Served at `/signup` too since 14 Nov; still marked noindex with `/early-access` as its canonical address until it is promoted past staging. Reads its two switches from `GET /api/site/early-access` (`mode` from `OPEN_SIGNUP`, `samCall` from `SAM_CALL`). |
| Staging way back to sign-in | `scripts/staging-back-link.mjs`, injected into every site page and the setup page: on a staging hostname only, it asks `GET /api/staging/signin` and, when the door is open, draws a fixed "Staging · Back to sign in" link to `/login` (Sol, 14 Nov). Live never asks. |
| `/login`, `/app` | the OS — compiled `web/app/index.html` + `/web/app/os.js`. `STATIC_INDEX` names the uncompiled root shell as a fallback only; compiled output wins when present. `SIGNIN_PASSKEY`, `SIGNIN_GOOGLE`, and `SIGNIN_MICROSOFT` are read on the server and stay off unless set to 1, true, yes, or on. With all three off, `/login` is the file on disk. With one on, the desk shell gets a `window.CDOS.signInFlags` script and no other auth route. |
| `/design-preview/signin`, `/design-preview/signin/<state>` | Sign-in frame gallery (`server/src/routes/signin-preview.ts`). Fake data, no auth call. Served only when the request Host is `currencydesk-staging.onrender.com`, `localhost`, or `127.0.0.1`. `www.currencydeskos.com`, `currencydeskos.com`, and every other host are 404. `x-forwarded-host` is ignored. The page is `noindex`. |
| `/admin` | the admin panel — compiled `web/app/admin.html` |
| `/onboarding`, `/onboarding/sso`, `/onboarding/<CD-ID>` | sign-up v2.1 (`web/signup.html`; `server/src/routes/signup-page.ts`). The ID is typed on the page, never carried in a link. `/onboarding/sso` is the Google/Microsoft return page. `?step=` opens a state only on a test server (`SIGNUP_TEST_SEED=1`, never production or staging) |
| `/onboarding/<reference>` | invite-code onboarding (`web/onboarding.html`; code read from the path). The code in the path (the application's reference) is the only key. A v2.1 application's CurrencyDesk ID comes from `GET /api/onboarding/:ref/state` (`application.cdId`) and is shown as theirs, never looked up as a code (`scripts/build-onboarding.mjs`, the bridge's `ID`; `asCode` reads anything else typed as a code, `fmtRef` recognises their own ID typed compact or with a typographic dash) |
| `/legal` `/faq` `/compliance` `/contact` | generated standalone pages |
| `/sites/yorkfx/*` | the customer storefront (`YorkFX/`); customer domains rewrite here via Host header |
| `/YorkFX/*` | storefront files on the root allow-list (the OS embeds the Rate Board in an iframe from here) |
| `/api/health` | public probe (no auth). `{ ok: true, service: "currencydesk-server" }`. No database read. Stays 200 while the process is up. Render `healthCheckPath`. |
| `GET /api/health/deep` | Tenant read, `commit` (7-character `RENDER_GIT_COMMIT`, or `unknown`), and `lastMigration` (newest `schema_migrations` id, or null when that read fails). **200** when the read works, **503** `{ ok: false, error: "database" }` when it does not. On Postgres the migration read sets `statement_timeout` to 1000 ms. Open with no session when the staging door is open (`STAGING` exactly `1`, staging host on the process and on the request). On live, the owner permission `team:manage`. No cookie is 401 before a session lookup. A 401 or 403 is `{error}` only, with no commit or migration fields. The result, including a 503, is cached in memory for 30 seconds. Narrative checks stay at authenticated `/api/admin/health` |
| `GET /api/staging/signin`, `POST /api/staging/enter` | Registered only when `stagingDoorOpen()` is true (`STAGING` exactly `1`). Each request calls `stagingDoorOpen` with the headers, which checks the Host through `isStagingRuntime` and ignores `x-forwarded-host`, and requires the demo shop `tnt-yorkfx`. A live host is 404. The flag is not in `render.yaml`. |
| `POST /api/staging/fresh-shop`, `POST /api/staging/fresh-onboarding` | Registered only when `stagingDoorOpen()` is true (`STAGING` exactly `1`). Each request calls `stagingDoorOpen` on the Host header. `x-forwarded-host` and `Forwarded` are not read. A live host is 404. The body is ignored. The handler holds a pending signup (`stg-<8 hex>`, `owner+<id>@staging.invalid`, trial, no regulator) and returns the 6-digit code and a one-time password once. Only hashes are stored. Nothing is emailed or logged. `POST /api/signup/verify` creates the shop. It sets `is_test_shop` and writes `staging.fresh_shop_created` only when that request passes `stagingDoorOpen` and the pending row is `stg-` plus `@staging.invalid`. Body fields do not set the column. The fresh owner has `mustChangePassword` true. `POST /api/auth/login/start` returns the sign-in code for that owner on a staging host and does not email it. A live host emails the code and does not return it. `POST /api/auth/login` stays `403 code_required`. Eight calls from one address in an hour (an IPv6 /64 counts as one address); the next is 429. The count is in memory for the process. It does not write `tnt-yorkfx`. The flag is not in `render.yaml`. The sign-in page shows Start a fresh shop only when `GET /api/staging/signin` answers `{enabled:true}`. `POST /api/staging/fresh-onboarding`, on the same door, starts the whole journey on the website: it returns `{ ok, start, email }`, where `start` is `/?door=<ticket>&email=<staging email>`, a one-time ticket (two hours, in memory) bound to a staging identity. On the site pages a small script (`STAGING_JOURNEY_HELPER` in `scripts/build-site.mjs`) sends the way in (`/signup`, `/early-access`) to `/early-access` with the ticket and keeps it on links between site pages; without a well-formed ticket it does nothing. The page applies with the ticket; `POST /api/enquiries` honours it on the staging door only and once (`takeStagingTicket`), applying as the staging identity with no founding number, nothing emailed (moveTo `quiet`), no operator alert and no research job, marked as the door's. A made-up, used or live-host ticket is 400. Accepted at once, "Start building your desk" opens `/onboarding/<reference>`. Launch sets `is_test_shop` when the door is open and that row was minted here. The confirm code is shown in a Staging code chip, the resend link stays hidden, and nothing is emailed. Billing refuses a test shop with 403 `TEST_SHOP` before any Stripe call. The founding count and the admin overview omit that door's application and any `is_test_shop` desk. A public enquiry cannot opt out by sending `stagingFresh`. Live does not register the route. |
| `POST /api/staging/day-one` | Start on Day 1 (Sol, 16 Nov). Registered only when `stagingDoorOpen()` is true (`STAGING` exactly `1`), in `server/src/routes/staging-day-one.ts`. Each request checks the raw Host first (a live, forwarded, preview or missing Host is 404), then takes only a same-origin JSON post: another `content-type`, a `Sec-Fetch-Site` other than `same-origin`, or an `Origin` other than this Host is 403 before the body is read. The per-address count is the fresh-shop routes' own (8 an hour, an IPv6 /64 as one address), plus a process-wide 30 an hour; past either it is 429. `server/src/onboarding/staging-day-one.ts` checks the `db_environment` marker before any write (503 `staging_unavailable` otherwise), mints a new staging identity, and drives the real v2.1 services in the page's order to the point before Open: the reservation as the ticket branch of `POST /api/enquiries` writes it, invited quietly, a generated password, the ordinary code handed back in process, verify, a generated strong PIN, the chapters, the signature as "Staging Owner", the call stopped and the staging plan. It re-checks the fixture provenance before each write step. 201 `{ ok, cdId, operatingName, signIn: { email, password, pin } }` once, with the ordinary `cd_enrol` cookie; only hashes are stored, nothing is mailed, fetched or logged, and a refusal logs a bounded reason only. The sign-in page's Start on Day 1 writes a bare timestamp (`cdDayOne`) in its tab and opens `/onboarding#day1`; the sign-up page acts on `#day1` only with that mark under a minute old, posts once, asks `/resume`, `/staging-open` and `/open`, and shows the sign-in once on Day 1 (`data-staging-day-one`). Live does not register the route. |
| `GET /api/workspaces/:slug` (`server/src/routes/workspaces.ts`) | Early Access v2.1 address check, public, no sign-in. Answers `{ slug, available, suggestions[] }`: taken when a desk uses the address (`tenants.site_slug`), a sign-up in progress holds it (`pending_signups.slug`), or an application that was not declined asked for it (`enquiries.details.workspace`); a reserved word is never free. Up to three free alternatives in the design's order. Never cached; 60 checks a minute per client address (`clientIp`). The reserved words and the address shape are one module, `server/src/onboarding/reserved-slugs.ts`, shared with sign-up and desk creation. |
| `POST /api/enquiries/:reference/sam` (`server/src/routes/enquiry-sam.ts`) | Early Access v2.1 "Call later", public, no sign-in. `{ at }` (or null for as soon as allowed) is moved into calling hours in the applicant's zone (`server/src/enquiries/sam.ts`: weekdays 9:00 to 21:30, weekends 10:00 to 18:00, last start five minutes before the end; the browser's zone, else the province's), kept on `enquiries.sam_call_at` in UTC with `sam_call_zone`, and returned. Only an accepted v2.1 application (Invited, with a CurrencyDesk ID) with consent on record for the number it gave and no stop after it; otherwise 404 or 409. Thirty bookings an hour per client address. Consent is `enquiry_call_consents` (migration 073): number, exact sentence, address, Cloudflare country, browser; only ever inserted, and a stop is another row that `growth/calls.ts` honours. |
| `npm run staging -- mark-db`, `npm run staging -- reset-pins` (CLI, `server/src/staging/cli.ts`) | No HTTP route. `mark-db` inserts the one `staging` row into the insert-only `db_environment` table (migration 060; a trigger refuses UPDATE, DELETE and TRUNCATE) with an audit row, only when `isStagingRuntime` is true; a second run is a no-op, and no row means live. `reset-pins` runs the staging PIN reset (`server/src/staging/pin-reset.ts`), which also runs at boot after the demo seed: with that row, a staging runtime and `is_test_shop`, it stores 0000 as everyone's PIN in test shops and never touches a shop with a Persona key or inquiry, a live Stripe event, a filed report or a real FINTRAC number. Both use `DATABASE_URL`; there is one database role. |
| `npm run persona -- register-webhook` (CLI, `server/src/idv/cli.ts`) | No HTTP route. Registers the Persona webhook for the inquiry events the adapter handles. Sanctions stay in house, so watchlist events are not subscribed. Default URL `https://currencydesk-staging.onrender.com/api/webhooks/idv/persona`, or `--url`. Refuses unless `isStagingRuntime` is true. `--production` is refused until go-live (CD-219), and a live Persona key is refused regardless of flags. Live Persona is blocked in code until a later change with Sol's yes. The secret-file write stays in the command and is not reached. Lists webhooks first and does not create a duplicate URL. Run it only in an interactive shell, never as a job or a deploy step. If the output may have been kept, rotate the secret. On staging the signing secret is printed on stdout once and is not logged, written, or sent on. |
| `GET /api/public/rate-pages/:slug`, `GET /api/public/screens/:token` (`server/src/routes/rate-pages.ts`) | Rates v2.5 public reads, no sign-in. The shop's rate page once the owner turns it on, and one window screen by its random token. Both answer the latest published board from `rate_boards` through `server/src/rates/public-board.ts` (code, buy, sell only) and are 404 for a suspended shop. Desk side: `GET`/`PUT /api/rate-page` (owner) and `/api/window-screens` (`rates:change`), stored in `shop_rate_pages` and `window_screens` (migration 062). The editor: `PATCH /api/rate-page/content` (what the page says, migration 063; contact and hours by day go to `tenants.site_config`), `GET /api/rate-page/preview` (staff, live or not), `POST /api/window-screens/:id/reset`, and the logo (`PUT`/`DELETE`/`GET /api/rate-page/logo`, public at `/api/public/rate-pages/:slug/logo` and `/api/public/screens/:token/logo`; checked in `server/src/rates/logo.ts`, migration 064). A screen's last sighting: `window_screens.last_seen_at` (migration 066), written by the public screen answer at most once a minute (`screenSighted`). Take it further: `POST`/`DELETE /api/rate-page/domain-request` (owner; `shop_rate_pages.domain_request`, migration 068; the request is also an enquiry of kind `contact` in the admin console's messages). Framing: every HTML answer carries `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` except `/r/` pages (`frame-ancestors *`, for the embed code), set in `server/src/app.ts`. Position (`GET /api/ledger/position`) also gives each currency's `avgCostHome` and the branch's `unrealizedPnlHome`, the figures the Rates screens show. Guardrails at post: `POST /api/quotes/:id/post` refuses a deal under its margin floor (422 `MARGIN_BELOW_FLOOR`) unless `marginOverrideReason` or a manager's rate override gives a reason; the rule is `server/src/rates/guardrails.ts`, the settings are the desk document's `cdos_settings`, each such deal is audited as `deal.margin_below_floor`. Lock rates: `PUT /api/rates/lock` (`branches.rates_locked_at`, `rates_locked_by`, migration 067); while set, `POST /api/rates/publish` answers 409 `rates_locked` and `publishFromMarket` leaves the board alone. Auto-publish: `PUT /api/rates/auto-publish` (`branches.auto_publish_rates`, migration 065); `server/src/rates/market.ts` publishes every branch with it on from each pull, in its home currency (`midsInHome`), never moving a pinned row. `server/src/rates/rate-page.ts` makes each shop's page (also at provisioning), validates and resolves its content, and makes the storefront's hours lines from the week (`hoursFromWeek`, used by `PATCH /api/rate-page/content` and `PATCH /api/tenant`). |
| `/r/:slug`, `/s/:token` (`rates-public/rate-page.html`, `rates-public/window-screen.html`) | Rates v2.5 public pages, one file each for every shop. The rate page and a window screen read `/api/public/rate-pages/:slug` and `/api/public/screens/:token`; no sign-in, no shop data in the file, shop text written as text. Both load `/shared/currency-face.js` for flags and names; the rate page's fonts come from `/web/fonts`. Served from the repository root through the static allow-list (exact file names). |
| `/api/*` | the API. Ledger, quotes and client-records routes register **only when a database URL is configured** |

The root allow-list in `server/src/app.ts` still names `CurrencyDesk OS.html`, `admin.html`, and `/os-src/` so a deploy that skipped `npm run build:os` can boot the hand-written shells. When `web/app/index.html` is in `STATIC_DIR`, a direct fetch of `/CurrencyDesk OS.html` or of anything under `/os-src/` except `/os-src/york-os.css` is a 404, including a browser navigation. It is not answered with the marketing page. When `web/app/admin.html` is present, `/admin.html` is a 404 the same way. `/shared/id-document-types.js`, `/shared/counter-cash.js`, `/shared/rolling-24h.js`, and `/shared/lctr-reversal.js` are on the list for the uncompiled shell and are a 404 with `os-src/` once the compiled OS shell is present. `/shared/currency-face.js` is served in every case, for the desk and the public pages. Nothing else under `shared/` is served. The compiled desk links `/os-src/york-os.css`, so that stylesheet stays public either way. `/assets/`, `/YorkFX/`, `/web/`, `/yorkfx.css`, and `/yorkfx-converter.js` are unchanged. The two shells are gated separately: a half-built `web/app` hides only the file whose compiled replacement is on disk. When `NODE_ENV` is `production`, a missing `web/app/index.html` logs that the uncompiled shell and `os-src` are public, and a missing `web/app/admin.html` logs that the uncompiled admin shell is public. The admin warning does not mention `os-src`. The same boot logs nothing when `NODE_ENV` is unset or `test`. The fallback itself stays, so a skipped build does not take the desk down.

## Databases

- App tables: Drizzle; embedded PGlite (dev/test) or Postgres (`DATABASE_URL`).
  Boot applies `DDL` + `runMigrations`. A fresh database self-provisions.
  `runMigrations` logs `opening database` before its first query and one
  `migration applied: <id>` line for each migration it applies. A later
  run logs no applied line for a migration already stored.
- Market rates: `listenServer` reads the newest `market_rates` row and,
  when it is older than the gap, inserts one snapshot and publishes one
  board for the demo branch. The gap is exactly 60 minutes.
  `RATES_SYNC_MINUTES` is clamped to 60, lower and higher. A value other
  than 60 logs one boot warning and is ignored. After a fresh snapshot
  the timer waits the full 60 minutes. A snapshot that is already part
  way through that hour waits only the remainder. The timer does not
  query every 15 minutes. `RATES_SYNC=off` does not start it.
- Shop domains: the Host map is memory (`server/src/sites.ts`). Boot loads
  it once. Saving or clearing a domain, and deleting a desk that had one,
  reload it on this process. That instant reload assumes one server
  instance. Staging and live each run as a single instance. Live's compute
  plan in render.yaml is the paid plan 1c-2g (1 CPU, 2 GB), set by the
  owner, and must not be set back to free. Staging is a separate service
  and is not in that file.
  With more instances, a domain saved on one can lag on the others until
  the safety reload, up to 30 minutes. The safety reload runs every 30
  minutes, or longer when `SITE_DOMAIN_REFRESH_MINUTES` is set, and never
  longer than 24 hours. Anything under 30 is 30. Anything above 1440 is
  1440. An unknown Host does not query the database. A Host with one
  trailing dot matches the saved domain.
- Ledger tables: raw SQL — `server/src/ledger/migration.sql` registered as
  migration `001_ledger`, then `server/src/db/migrations/002…`. Append-only
  book. Invariants: `docs/CASH_OWNERSHIP_INVARIANTS.md`.
- Adding a migration touches **three places**: the SQL file, the list in
  `server/src/db/migrations.ts`, and (for Drizzle-managed tables) the `DDL`
  constant in `server/src/db/index.ts` + `server/src/db/schema.ts`.
- Migration `083_staff_sign_in_identities` adds `staff_identities`,
  `staff_passkeys`, `auth_challenges`, `staff_recovery_codes`, and
  `staff_totp`. The same issuer and subject can be linked in two shops,
  and not twice in one shop. One staff row has one link per provider.
  `auth_challenges.tenant_id` and `staff_recovery_codes.tenant_id` are
  required. It also adds `tenants.ms_tenant_allowlist` (null means
  that shop has not turned a Microsoft tenant allowlist on) and
  `sessions.step_up_at`. PGlite applies the file from `createDb` because
  it does not run the SQL migration list. The tables are also in the
  boot DDL. No sign-in route reads them until a later change. 082 is the
  PEP answer log.
- Migration `075_sanctions_lists` adds `sanctions_list_snapshots`,
  `sanctions_list_entries`, `sanctions_ops_flags`, and
  `sanctions_score_settings`. 074 is the Persona inquiry client on PR 722,
  so this file is 075.
  The list addresses and the placeholder threshold are
  `docs/SANCTIONS_LISTS.md`. The daily fetch starts in `listenServer`
  unless `SCREENING_FETCH` is `off`.
- Migration `076_sanctions_reviews` adds the screen result, the review
  queue, the decision log, and the client's PEP answer. Migration
  `077_sanctions_review_rules` names the shop's compliance officer, keeps
  decisions for 5 years, and refuses clearing a confirmed match.
  A quote, a cheque, a remittance, a bill, and a money order all pass
  one hold. `POST /api/quotes/:id/post` holds a possible or confirmed match.
  `GET /api/screening/reviews` is the named compliance officer. A teller
  gets 403. `POST /api/screening/id-check` runs on every tier. Returning client (tier 2, and the old word quick) and ID and selfie (tier 3, and the old word verify) store the client's PEP answer. In person is tier 1. ID, selfie and database is tier 4 (the old word plus) and does not store a PEP answer on this route. No vendor is called.
- Migration `081_idv_check_records` adds the ID check record, consent, deal link, supersession, number reveal, and face-crop view. 078 to 080 are claimed by open sign-up PRs, so this file is 081. Updates and truncates stay blocked. A row delete is allowed only after `retain_until` (5 years after the check). Clearing the face crop columns is allowed only after `face_crop_retained_until`. The document number and the face crop are AES-256-GCM ciphertext from HKDF subkeys of `ID_NUMBER_KEY` (`key_version` 1). A shop with the face crop off, or a check with no crop, shows "No photo on file". Persona full images and selfies are not stored. `branches.province` is the Quebec gate: unknown or Quebec is counter only, including a start with no tier. The staging demo branch `br-yorkville` is set to ON. PGlite runs this file from `createDb` because it does not run the SQL migration list. The counter screens are `os-src/cdos-id-check.jsx` (client file, staged deal, and Settings). `GET /api/idv/clients/:clientId/checks` also returns each record's deal ids. `GET /api/idv/checks/:recordId/reveals` lists number reveals for supervisor, branch manager, compliance officer, and administrator. The consent read includes the counter-only gate.
- Migration `072_enquiry_v2_1` adds `enquiries.cd_id` (unique), `waitlist_reason`
  (checked: `outside-canada` or `not-fintrac-registered`), `invite_code`
  (unique) and `place_in_line` for Early Access v2.1 (CD-179 to CD-183). The
  same columns are in the boot DDL and `schema.ts`. 069 to 071 are held by
  open PRs on main.
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
- Migration `074_idv_inquiry_client` adds `idv_inquiries.client_id` (nullable, no foreign key: client files live on the ledger database). 073 is the previous file. The column is also in the boot DDL because PGlite does not run SQL migrations. `POST /api/idv/start-check` stores it when the body names a client on the caller's shop. `GET /api/idv/clients/:clientId` returns that client's latest status. `GET /api/idv/clients/:clientId/checks` uses that same client lookup, including when the file lives on the ledger connection. A client with no check returns an empty list. The client file shows the status. `POST /api/idv/checks/in-person` records a counter check with no Persona call and no photo. With no `ID_NUMBER_KEY` it answers 503 "ID number storage is not set up for this shop yet." and the in-person screen shows that sentence. `POST /api/idv/checks/returning` re-screens sanctions and the PEP answer for this shop only, and still runs when there is no photo ("No photo on file"). `POST /api/idv/consents` stores consent before `POST /api/idv/inquiries/:inquiryId/one-time-link`. The link is refused with no consent, in Quebec, or when the branch province is unknown. A terminal webhook fetches the inquiry with `include=verifications`, drops photo fields, and may keep one encrypted 96 by 96 crop from the ID front photo. `POST /api/idv/checks/:recordId/reveal` and `POST /api/idv/checks/:recordId/face` audit the view in the same transaction. Persona 30-day redaction policy (images, selfies, facial geometry, including Accounts) must be on before any real customer check. CD-219, addendum 4.4.
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

Browser, Server, Civil dates and Governance run on pull requests and pushes
to `main` or `staging`. The dedicated `staging` branch supports staging-only
delivery without a push to `main`. The Render staging service's source must
be changed separately; its verified setting on 13 November 2026 is still
`main`. Live follows `release`. See `docs/DEVELOPMENT.md` for the transition,
database-isolation checks and promotion boundary.

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

### Local signup test facilities

`server/src/seam-breach-range.ts` supplies deterministic HIBP range responses
only through the local `seam-server.ts` entry. It wraps the exact provider GET
and delegates other fetches unchanged; `localTestRuntime` is checked on every
request. The production entry never imports it. Clean, breached, unavailable,
aborted and deployment-refusal cases retain the real password checker.

`server/src/local-test-runtime.ts` gates signup screenshot seeding and the
seam-only code mailbox. Both require explicit test/development mode, loopback
bind and database hosts, no deployment/staging marker, and loopback request
IP/Host. Database host overrides are parsed with the PostgreSQL driver parser.
The mailbox is memory-only and cleared when its server closes. It is not a
staging code-delivery mechanism.

### Signup on staging: the synthetic shop

`server/src/onboarding/signup-staging.ts` is the staging code-delivery and
no-card path, for the staging door's own reservation only. `stagingSignupFixture`
requires `stagingDoorOpen` on the raw Host (forwarded hosts ignored), exactly one
`db_environment` row `staging`, and server-written provenance: `details.stagingFresh`,
the "staging test shop" do-not-contact reason, and `owner+<h8>@staging.invalid` with
`details.slug` `stg-<h8>`. For that reservation the credential and resend responses
carry `stagingCode` (the ordinary code, never mailed), `POST …/payment` prepares the
plan without Stripe, and `POST /api/onboarding/:id/staging-open` records assent and
runs the shared activation as a test shop; `POST …/open` then upgrades the session.
`stagingFixtureOwner(db, headers, staffId, tenantId)` is the same proof for a returning
owner (tenant, accepted reservation, email and slug correlated). Nothing ever mails a
`@staging.invalid` address. Without the database marker every gate stays closed.

Start on Day 1 (`server/src/onboarding/staging-day-one.ts`, `POST /api/staging/day-one`)
makes that same reservation and walks it, in process, through the same services the
page calls, up to Open. The page (`signup-v2.1-open.js`, `CD.dayOne`) then makes the
usual `/resume`, `/staging-open` and `/open` calls on the enrolment cookie, so the desk
opens through the same assent row, activation and session upgrade as any staging Open.
From the press until the desk opens, the page holds: a neutral status (the build's
`data-staging-day-one-hold`) over a page made inert, with `CD.holding()` stopping
Continue, the skips and Back, so no shop screen shows before the server has named the
shop and nothing can drop its answer.
The server signs the declaration as "Staging Owner" for that fixture only and audits
`staging.day_one`. Shared pieces it uses: `freshStagingIdentity`, `allowFreshShop` and
`allowDayOne` (routes/staging-fresh-shop.ts) and `saveSignupAnswers`
(onboarding/signup-answers.ts, also behind `PUT …/answers`).

`design/onboarding/signup-v2.1-audio.js` owns signup click sound scheduling and
the account-menu mute preference. Pointer/key press only wakes the context;
action or fallback sound runs on a frame within 180ms, once per click. It drops
late async/timer tones and suppresses generic taps within 80ms. The frozen
waveforms remain the source; no sound plays on page load.

### Signup Day 1 inside the OS

`os-src/cdos-signup-home.js` reads the signed-in administrator's own `/api/tenant`
record for embedded `/app?onboarding=welcome`, and requires its signup v2.1 marker.
The existing OS shell renders an inert Home with actual identity/setup status,
locked apps and no till selection or automatic first-run tour. Missing proof,
other roles, mismatched tenants and ordinary `/app` use normal routing. This
welcome stage never enters the desktop effects that claim/open a till. Its
readiness message is accepted only from that iframe, origin and activated tenant.
`signup-v2.1-open.js` renders the iframe declaratively after `/open` succeeds;
prototype chrome remains only for local review seeds. Build my desk hands off to
the normal `/app` entry. The subsequent walkthrough remains separate work.

The signup `signup-v2.1-setup.js` view adapter labels opening counts as draft
amounts by currency; it never supplies a converted cash valuation.
