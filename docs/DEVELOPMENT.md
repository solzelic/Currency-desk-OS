# Development

> **Rewritten 2026-08-03.** The previous version told you to run `npm run dev`
> and open a Vite app at `frontend.html`. There is no Vite app and no
> `frontend.html` — that build was deleted (its CI was green while the shipped
> code went unwatched). Every command below was run against this repo before
> being written down.

## Prerequisites

- Node.js 22 or newer (`.nvmrc` pins it; CI uses the same).
- npm 10 or newer.

Two npm projects, on purpose: the repository root builds what the browser
loads, and `server/` is the API. They have separate lock files and are
installed separately.

```sh
npm ci                 # root — build scripts, Playwright, browser vendor
npm ci --prefix server # the API
```

## Run it

The server serves everything — site, OS, panel and API on one origin. There
is no separate front-end dev server to start.

```sh
cd server && npm run dev:prototype
```

That runs `tsx watch` with `STATIC_DIR=..`, so the repository root is the
static directory exactly as Render configures it. Then:

| | |
|---|---|
| `/` | the marketing site |
| `/app` | the OS — what a teller uses |
| `/admin` | the platform panel — our side |
| `/api/health` | `{"ok":true}` when it's up |

**No database to install.** With `DATABASE_URL` unset the server runs an
embedded Postgres (PGlite) in `server/.pgdata`, so a clone is runnable in one
command. Set `PGLITE_MEMORY=1` for a throwaway one that leaves nothing behind.

## Editing the browser code

`os-src/*.jsx` and `admin.html` are hand-written JSX and are the thing you
edit. `web/` is **generated — never hand-edit it.**

```sh
npm run build          # onboarding + site + os
npm run build:os       # just the OS and the panel, if that's all you touched
```

`dev:prototype` deliberately serves the **uncompiled** OS at `/app`, so you
edit a `.jsx` and refresh — no build step in the loop. The browser compiles
the JSX itself, which is why the source still carries the CDN tags the built
output strips. Production serves `web/app/` instead, and prefers it whenever
it exists.

**CI fails if `web/` is stale**, so run the build and commit its output with
any change to a source it's generated from.

## Check it

```sh
npm run check:parse            # every browser file parses — cheapest gate there is
npm test --prefix server       # 397 server tests
npm run typecheck --prefix server
npm run test:e2e               # the customer journey, in a real browser
```

`npm run check` at the root runs build + parse + e2e together.

The Postgres-only suites (ledger, quotes, migrations) skip unless
`TEST_DATABASE_URL` is set. CI provides one; locally they're skipped and that
is not a failure — but it does mean the ledger's money paths are only truly
exercised in CI. If you're changing the ledger, point it at a real Postgres:

```sh
TEST_DATABASE_URL=postgres://... npm run test:ledger:postgres --prefix server
```

## Things that will catch you out

- **Two lock files.** `npm ci` at the root does not install the server.
- **Exact pins are deliberate.** `react`, `react-dom`, `@babel/standalone` and
  `tailwindcss` have no caret. A different version than the built output was
  produced with is drift nothing else would notice — and a mismatched
  integrity hash renders the app as a black rectangle. It has happened.
- **`web/` is generated.** An edit there survives until the next build and
  then vanishes.
- **York FX is seeded on every boot** and is the demo desk. Its state stays in
  the browser rather than the server (`tnt-yorkfx` is skipped by the
  persistence bridge on purpose) so the rehearsal desk cannot be dirtied.
