# Developing CurrencyDesk — commands and hard-won gotchas

(Replaces the deleted Vite-era instructions; every command here has been
run before being written down. Workflow rules live in `AGENTS.md` and
`CONTRIBUTING.md`; the repository layout in `docs/REPOSITORY_MAP.md`.)

## Run it

```bash
cd server && npm ci
npm run dev:prototype        # http://127.0.0.1:8787 — site at /, OS at /app, API under /api
```

## Build and verify

```bash
npm ci                       # repo root
npm run build                # regenerate web/ from the design + OS sources
npm run check:parse          # every browser script parses
npm run check:sanctions      # banned-name variants, then the built web/app/os.js

cd server && npm run typecheck && npm test          # embedded PGlite suite
TEST_DATABASE_URL=postgres://…/freshdb npm test     # + the Postgres invariant suites
SEAM_DATABASE_URL=postgres://…/freshdb npm run test:e2e   # browser↔ledger seams (repo root)
```

**Use a fresh disposable database per full run** — several suites
deliberately leave ledger state behind (an append-only book is the point).

The local browser seam replaces only HIBP's exact range GET through
`server/src/seam-breach-range.ts`, installed by `seam-server.ts`. The real
password validator and range parser still run. Synthetic fixture phrases
exercise breached and unavailable responses; other ranges return a padded
zero-count record. Production `index.ts` never imports the fixture, and its
runtime guard refuses production, hosted staging, Render and non-local databases.
The dedicated localhost staging simulation can set
`CD_TEST_BREACH_RANGE=local-staging` with its exact
`staging.currencydeskos.com` test hostname; this relaxes only the simulated
staging markers, never the deployment or loopback/database checks.
Hosted provider checks remain real and fail closed on provider failure.

## Browser screenshot output

`staff-switch-seam.spec.ts` and `till-handover.spec.ts` save their named
screenshots through `tests/e2e/screenshot-path.ts`. By default each file goes
into Playwright's per-test output directory (`testInfo.outputPath`), including
its retry isolation. Set `CDOS_E2E_SHOTS_DIR` to collect them in an explicit
directory instead; missing parent directories are created recursively.
An unset or exactly empty value uses the default. Whitespace is preserved;
relative paths resolve from the runner's working directory. An unwritable
path fails the test rather than silently dropping evidence. Give concurrent
runs different override directories, because the fixed filenames can collide.

When both specs finish, they produce fourteen named PNGs. They no longer require
`/opt/cursor` paths or copy files automatically to `/cursor/stores/self/pr163`.
This output change does not alter their financial fixtures or assertions.

## Testing rules that were learned the expensive way

- **Assert deltas, not absolutes.** A test that asserts a global total
  (`outstanding.payable === "600.00"`) passes only while it is the only
  file that ever posted. Assert what your test changed.
- **Shared fixtures still outlive a file.** Suites can leave a till or a
  jurisdiction pack behind (a GBP pack on the demo entity makes CAD
  assertions fail). If a test passes alone and fails in the suite, look
  there before chasing a race. Adding a till no longer denies unscoped
  callers — that was issue #34, and the session workspace is the rule
  now. The day-at-the-desk gate trades on its own till.
- **Drive the seam to verify wiring.** A server test and a browser test
  both green while the join is broken is how every serious cash defect
  here survived CI.

## Buildless-JSX gotchas (the OS compiles in Babel, not a bundler)

- `\uXXXX` escapes render literally in JSX text — use the real character.
- Regex literals and incomplete ternaries inside JSX break Babel with
  "Unexpected token, expected ':'".
- Fixed-position overlays inside `#os` need
  `ReactDOM.createPortal(..., document.body)` to escape the stacking
  context.

## Local database and email

- **PGlite**: never open `server/.pgdata` with a second process while the
  dev server holds it — it corrupts the directory. Reset with
  `rm -rf server/.pgdata` (re-seeds the demo desk).
- **Signup email codes**: sensitive messages are refused when the delivery
  provider is unavailable; codes are never logged. The seam entry can open an
  ephemeral in-memory mailbox with `CD_TEST_MAILBOX=1`. This and
  `SIGNUP_TEST_SEED=1` require explicit `test`/`development`, loopback bind and
  database hosts, no staging/deployment marker, and loopback request IP/Host.
  These flags do not expose codes on staging. A mailbox is cleared on close.
- **Staging synthetic shop**: on the hosted staging service only, the reservation
  minted by `POST /api/staging/fresh-onboarding` gets its signup code on screen and
  opens without a card (`server/src/onboarding/signup-staging.ts`). It needs
  `STAGING=1`, a staging `RENDER_EXTERNAL_HOSTNAME` and Host, and the database marker
  from `npm run staging -- mark-db`; any missing piece closes it and the page asks
  for the emailed code as usual. Ordinary reservations never get a code in a response.
- **Staging Start on Day 1**: to try the onboarding after payment without walking the
  sign-up, open `https://staging.currencydeskos.com/app` and press **Start on Day 1**
  (beside Start a fresh shop, both tagged Staging). A few seconds on a holding screen
  ("Opening a staging test shop…", then the new shop's name; nothing under it can be
  pressed) later, the same tab is on Day 1 of a brand-new test shop, signed in as its
  owner, over the real Home: Build my desk, the tour and the first apps from there.
  Every press is a new shop. The boxed line under Build my desk gives the counter PIN
  (needed to take a drawer; it becomes 0000 when staging next restarts) and the owner's
  email and password (Forgot PIN asks for the password). Note them: they are shown
  once, never stored in the browser, and a reload drops them. Signing that owner in
  again from the sign-in page waits on CD-221; until then the browser stays signed in
  for 12 hours, or press the button again for another shop. It needs the same staging
  pieces as above, including `npm run staging -- mark-db`; without the marker it says
  the staging door can't open a shop. Eight presses an hour per address (shared with
  Start a fresh shop) and 30 an hour in all.
  Locally, `tests/e2e/staging-day-one.spec.ts` runs it against a staging-shaped server
  on its own database (`SEAM_DATABASE_URL=… npx playwright test tests/e2e/staging-day-one.spec.ts`).

## Sandboxed/CI environments

- CDNs may be blocked: the e2e fixtures serve React/Babel from
  `node_modules` via route interception; if Playwright cannot find a
  browser, point `PW_CHROMIUM` at a Chromium binary
  (e.g. `/opt/pw-browsers/chromium`).
- A Playwright `goto` that only changes the URL hash does not reload —
  call `reload()` or the app never re-boots.
- The admin panel's sign-in field is `type=email`; authenticate via
  `/api/auth/login` in-page when driving it with a non-email id.
- There is no outbound access to production from a sandbox — verify
  against localhost.

## Staging delivery and live promotion

The two Render services are separate: `currencydesk-staging` is the test
application and `currencydesk` is live. Production follows `release`.
Updating `release` is a production deployment and requires explicit promotion
approval. A successful staging test is not that approval.

For work authorized only for staging, publish tested commits to `staging`.
Browser, Server, Civil dates and Governance run on pushes to that branch as
well as `main`, and on pull requests. Keep the exact commit with each result;
a green run on an older candidate is not evidence for a later one.

Hosting transition checked on 13 November 2026: Render's staging service
still follows `main`. Before the dedicated branch can deploy, change only
`currencydesk-staging`'s Branch setting to `staging`. Keep the live service
on `release`. Do not push to `main` to work around this pending setting.

Before testing the hosted candidate, verify that its `DATABASE_URL` and any
`LEDGER_DATABASE_URL` resolve to a staging database, that `STAGING` is `1`
only on the staging service, and that provider credentials are appropriate
for test data. Compare connection targets without putting passwords in
logs or tickets. Separate service names alone do not establish database
isolation. Record an inaccessible setting as unverified.

After a staging deploy, confirm Render's deployed SHA and the staging
`/api/health/deep` result, then exercise the affected flow with synthetic
records. Production promotion uses that same verified commit on `release`
only after the owner's explicit approval. Verify the production deploy's
commit separately and retain the previous deployed commit for recovery.

Signup page return queries must not be logged or used as payment proof. Its
no-referrer/no-store response hook is synchronous: do not add a second async
onSend hook. That extra yield can double-send existing async guard refusals and
crash a real HTTP server despite injection tests passing. The return-log suite
also exercises two unauthenticated refusals over an actual local listening socket.
