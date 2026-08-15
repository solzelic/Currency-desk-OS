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

cd server && npm run typecheck && npm test          # embedded PGlite suite
TEST_DATABASE_URL=postgres://…/freshdb npm test     # + the Postgres invariant suites
SEAM_DATABASE_URL=postgres://…/freshdb npm run test:e2e   # browser↔ledger seams (repo root)
```

**Use a fresh disposable database per full run** — several suites
deliberately leave ledger state behind (an append-only book is the point).

## Testing rules that were learned the expensive way

- **Assert deltas, not absolutes.** A test that asserts a global total
  (`outstanding.payable === "600.00"`) passes only while it is the only
  file that ever posted. Assert what your test changed.
- **File order is currently load-bearing** in the seam suite, because
  suites leave shared fixtures behind (one adds a till to the demo branch;
  another repoints the demo entity to a GBP pack — symptoms are
  `SCOPE_DENIED` or CAD assertions receiving GBP). If a test passes alone
  and fails in the suite, this is why — do not chase it as a race. The
  `zz-` prefix on the deployment gate is the documented workaround until
  the multi-till defect (issue #34) is fixed.
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
- **Email codes**: without `RESEND_API_KEY`, one-time codes are written to
  the server log (the e2e fixtures read them from there). With it set,
  codes are sent, not logged.

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
