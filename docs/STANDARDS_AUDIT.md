# Engineering standards audit of `main`

**Audited:** 2026-09-04 against `origin/main` at `f31cf21`  
(*Record the compiled-OS slice review against live production*, #44).  
**Standard:** Notion *Engineering standards* (stack-agnostic), scored as
written on that page. This document is the in-repo record of that scoring.
It does not ship product behaviour.

**Method:** read `docs/PROJECT_STATE.md`, `docs/REPOSITORY_MAP.md`,
`docs/ARCHITECTURE.md`, `docs/CASH_OWNERSHIP_INVARIANTS.md`,
`docs/MIGRATION.md`, `docs/SECURITY_COMPLIANCE_FOUNDATION.md`, then
traced the runtime paths those docs name. Residual issues #31–#36 and
the public-shell / health / PR #30 items were re-verified in code, not
from memory of a previous session.

Scores: **Pass** / **Partial** / **Fail** / **N/A**. Every Partial and
Fail cites a path.

---

## Understanding (what this system is)

CurrencyDesk is a multi-tenant SaaS operating system for currency-exchange
houses, deployed as **one Render web service** that auto-deploys `main`.
One Fastify process serves every surface from the repository root behind
an allow-list (`server/src/app.ts`).

| Layer | What it is |
| --- | --- |
| Server | Fastify + Drizzle + Zod, TypeScript, `server/src/`. Embedded PGlite in dev/test; Neon Postgres in production. Boot applies idempotent `DDL` then checksummed SQL migrations. |
| Ledger | Raw `pg` SQL under `server/src/ledger/`. Append-only double-entry book. `decimal.js` at the boundary. Idempotency keys. `SERIALIZABLE` + bounded retry. The single authoritative cash book. |
| OS | Buildless React in `os-src/` + shell `CurrencyDesk OS.html`, compiled ahead of time by `scripts/build-os.mjs` to `web/app/`. Production `/login` and `/app` serve `/web/app/os.js` when that file exists. |
| Admin | `admin.html` → `web/app/admin.*`. Cross-tenant platform console. |
| Marketing / onboarding | Generated into `web/` from `design/`. `/onboarding/:code` is invite-code onboarding. |
| Storefront | `YorkFX/`, served at `/sites/yorkfx` and via customer domains. |

**Where truth lives.** Every balance, movement and P&L is the server
ledger. The browser renders cash; it does not compute it
(`docs/CASH_OWNERSHIP_INVARIANTS.md`). The server mints identifiers.
A figure the ledger cannot answer is **absent, never zero**.
`localStorage` on a storefront is a cache, never a second book.

**What is closed.** The compiled-OS production slice is closed on `main`
(`90a3890`, #43; re-verified live in #44). Live `/login` and `/app` serve
the compiled shell.

**What this audit is not.** It does not open a product slice, merge to
`main`, or fix #31–#36.

---

## Scorecard

### §1 Slices — Partial

The repo already behaves like a slice shop in places, but the
standard's freeze/open/close ritual is not encoded as a rule the next
agent cannot skip.

| Evidence | Why |
| --- | --- |
| `docs/PROJECT_STATE.md` “Current active work”, `docs/ARCHITECTURE.md` §8 | The compiled-OS slice is named, closed, and stamped. That is the right shape. |
| `AGENTS.md`, `CONTRIBUTING.md` | One job = one branch = one PR. Main is not to be committed to. |
| `scripts/check-repository-governance.mjs` | CI forces a PROJECT_STATE stamp *or* an explicit “reviewed — no change required” box. |
| Missing | No in-repo rule that **main is frozen unless Sol has opened a slice**. No register of open slices. A “quick fix” can still land as a PR against an unlocked main. |
| `docs/ROAD_TO_DEPLOYMENT.md` | Dated 2026-08-05; useful history, not a slice board. Issue numbers in that file (#31 ledger headlines, #33 test isolation) collide with the current GitHub issues of the same numbers. |

The compiled-OS close is the only fully written end-state → stamp →
stop cycle on record. Everything else is a priority list.

### §2 Correctness at the boundary — Partial

The money and auth edges are parsed. Several other edges are not, and
typed escape hatches exist without a why.

| Evidence | Why |
| --- | --- |
| `server/src/routes/auth.ts`, `server/src/quotes/service.ts`, ledger `parseMoney` / `decimal()` helpers | HTTP bodies for login, quotes and ledger amounts are Zod- or Decimal-parsed at the edge. |
| `server/src/state/shape.ts` | The tenant state blob is catalogued per-key. The schema *describes* rather than refuses — deliberate, and said so. |
| `server/src/quotes/routes.ts:15` | `createBody` still `z.enum(["CAD","USD","EUR","GBP"])` after the ledger dropped that ceiling (migration 020, `server/src/quotes/service.ts` `type Currency = string`). A peso desk can float PHP and then fail to quote it. The OS stopped pre-checking the four-way list (`os-src/cdos-os.jsx` ~1028); the quote route did not. |
| `server/src/quotes/routes.ts:20–30` | `req: any`, `reply: any`, `(req.params as any).quoteId` — no comment saying why. |
| `server/src/routes/admin.ts:240, 270` | `gate(req: any, reply: any)` and `(who as any).platform`. Authorization is a remembered function at the top of each handler, not a hook (`docs/ARCHITECTURE.md` §8 item 5). |
| `server/src/state/shape.ts` | `z.record` / unknown-shaped document keys remain; ARCHITECTURE §3 still names this as the table-vs-document debt. |

Illegal states are unrepresentable in the ledger (append-only rows,
status CHECKs, `numeric` CHECKs). They are still representable in the
quote-create enum, the state blob, and several `any` admin paths.

### §3 Money — Partial

The book itself meets the standard. Two adjacent money paths do not.

**Pass on the ledger.**

| Evidence | Why |
| --- | --- |
| `server/src/ledger/migration.sql` | Amounts are `numeric(24,2)` / rates `numeric(24,12)`. No float on till, vault, journal, or transaction rows. |
| `server/src/ledger/*.ts` + `decimal.js` | Arithmetic is Decimal. Rounding is `toDecimalPlaces(2)` / `ROUND_HALF_UP`, set once (`quotes/terms.ts`, `quotes/service.ts`). |
| Frozen quote terms | `ledger_quotes` stores `market_mid`, `customer_rate`, amounts; posting consumes the stored rate (`docs/QUOTE_INVARIANTS.md`). |
| Append-only | No `UPDATE`/`DELETE` of `ledger_transactions`. Reversals are new rows that reference the original. `ledger_audit_events` is the trail. |
| Currency in the type | Ledger amounts travel with a `char(3)` currency. Three-decimal currencies are refused out loud (`server/src/ledger/currencies.ts`) rather than truncated. |
| One book | `docs/CASH_OWNERSHIP_INVARIANTS.md`. Browser `position()` is a headstone (`os-src/cdos-base.jsx` ~628). |

**Fail on two non-ledger money paths.**

| Evidence | Why |
| --- | --- |
| `server/src/db/index.ts:50–52`, `server/src/db/schema.ts:647–649` | Storefront SMS holds (`rate_quotes`) store `have_amount`, `quoted_rate`, `receive_amount` as `double precision`. |
| `server/src/routes/public-site.ts:210–215` | Those holds are computed with JS `*` `/` on IEEE floats: `mid * (1 - margin)`, `receive / amount`. A customer-facing rate, persisted. |
| `server/src/db/index.ts:386–387`, `schema.ts:347–348` | Rate-board `buy_margin` / `sell_margin` are `double precision`. |
| `server/src/db/schema.ts:366` | `market_rates.mids` is `jsonb` typed `Record<string, number>` — JS numbers. |
| `server/src/seed.ts:62–73` | Seed board mids are `Number((1 / units).toPrecision(6))`. |

`confidence double precision` on research facts and `attempts double
precision` on pending signups are not money; they are listed only so a
later reader does not confuse them with the finding above.

### §4 Data — Partial

| Evidence | Why |
| --- | --- |
| `docs/MIGRATION.md`, `server/src/db/migrations.ts`, `server/tests/migrations.postgres.test.ts` | Migrations are versioned, checksummed, immutable once applied, forward-only. Drift fails boot. |
| Ledger + most app tables | NOT NULL, FKs, CHECKs, unique keys live in SQL. Timestamps are `timestamptz` / `withTimezone: true` (UTC). |
| `docs/ARCHITECTURE.md` §8 item 4, `docs/MIGRATION.md` | Two schema mechanisms: boot `DDL` (`server/src/db/index.ts`) and checksummed SQL. PGlite applies `DDL` only — embedded and production schemas diverge by construction. |
| `server/src/routes/admin.ts:1415–1439` | `DELETE /api/admin/tenants/:id` hard-deletes staff, workspaces, boards, quotes, tenant state, legal entities, **and `audit_events`**. Gated on “must be suspended first”, then destroys the 6-year record the comment itself names. Standard: nothing explainable is hard-deleted. |
| `server/src/clients/routes.ts:305, 340` | Client document / scan DELETE endpoints. `ON DELETE CASCADE` on client-document FKs (`migrations/019_client_records.sql`). |
| `docs/SECURITY_COMPLIANCE_FOUNDATION.md` | Retention rules are written; no disposition engine. No RLS. |
| Missing | No in-repo backup/rollback runbook for a destructive migration. The hosting platform’s defaults are the plan. |

### §5 Failure — Partial

| Evidence | Why |
| --- | --- |
| Ledger `LedgerError` + route `fail()` | Typed codes, messages, no silent 200 on a refused post. Contention maps to `409 LEDGER_BUSY`, not 500 (`quotes/routes.ts`, ledger routes). |
| `server/src/ledger/retry.ts` | Retries only `40001` / `40P01`, bounded (6 tries), only around idempotent writes. |
| `server/src/growth/elevenlabs.ts`, `growth/research.ts`, `places.ts` | Those outbound calls have `AbortSignal.timeout`. |
| Missing | No timeout on Resend (`server/src/email.ts`), Stripe, Open Exchange Rates, or the Neon pool itself. |
| `server/src/index.ts:88` | `refreshSiteDomains(...).catch(() => {})` — swallowed. |
| `server/src/routes/enquiries.ts`, `admin.ts`, `auth.ts`, `staff.ts` | Email send failures become `"failed"` via `.catch(() => "failed")`. Often then surfaced to the operator; still a swallowed rejection. |
| `server/src/rates/market.ts`, `billing/stripe.ts`, `onboarding/provision.ts`, `ledger/thresholds.ts` | Bare `catch {` blocks. Some are parse-guards; they still hide the input that failed. |
| `server/src/cooldown.ts`, `routes/auth.ts` `loginChallenges` | In-process maps. A Render sleep or deploy drops in-flight sign-in codes and cooldowns (`docs/ARCHITECTURE.md` §8 item 2). |

### §6 Security — Partial

Authn/authz for desk users is real. The platform blast radius is not
priced. Several deploy-time holes remain.

| Evidence | Why |
| --- | --- |
| `.gitignore`, `server/.env.example`, `render.yaml` `sync: false` | Secrets are not in the repo. `.env` is gitignored. Render dashboard is the store. `git ls-files` shows no `.env` / key files. |
| Ledger SQL | Parameterized `$1…$n` / Drizzle. No string-built SQL found in `server/src/`. |
| `server/src/auth/sessions.ts`, `auth/password.ts` | Opaque httpOnly cookies; SHA-256 of the token at rest; scrypt passwords; sessions revoked on credential change. |
| Tenant scope | Session-derived. A caller-supplied tenant id is not a read scope (`docs/ARCHITECTURE.md` §4). |
| Browser React/Babel | Pinned exactly in root `package.json` (comment explains why). |
| `server/package.json` | Server runtime deps use carets (`fastify`, `pg`, `decimal.js`, `drizzle-orm`, `stripe`). Not pinned. No `npm audit` / secret-scan job in CI. |
| No MFA on `/admin` | Search of `server/src/` finds no TOTP/WebAuthn. Desk users whose staff id is an email get an emailed code (`login/start`); platform operators do not have a second factor. Issue **#33**. |
| `server/src/admin-bootstrap.ts:30–31` | While `PLATFORM_ADMIN_BOOTSTRAP` is set, every boot **overwrites** the operator password and clears `mustChangePassword`. Issue **#31**. |
| Issue **#32** | Resend key passed through chat. Cannot be verified from the repo. Ops-only; stays open until an operator confirms rotation. |
| `server/src/app.ts:66–85` | Public allow-list still serves `/CurrencyDesk OS.html`, `/admin.html`, and `/os-src/*` (Babel + `react.development` + the entire OS source). Product routes `/login` and `/app` do not use these; they remain fetchable. |
| `render.yaml:39` | Render’s probe is `GET /api/health` — process-alive only (see §9). |
| Least privilege | Platform roles exist (`server/src/platform/team.ts`) and are least-privilege by default. The app connection string’s role on Neon is not declared in-repo (likely the DB owner on a free Neon project). |

### §7 Tests — Partial

The things that can hurt money are tested. One named flake is tolerated.
CI does not run on `main` after merge.

| Evidence | Why |
| --- | --- |
| `server/tests/*.postgres.test.ts` | Ledger, quotes, cheques, obligations, cost-basis, currencies, thresholds, client records, filings — against disposable Postgres. |
| `tests/e2e/*-seam.spec.ts` | Browser drives the screen; the test then asks the ledger. CI `browser-seam` fails if a spec silently skips (`scripts/check-seam-ran.mjs`). |
| `server/tests/auth.test.ts`, `login2fa.test.ts`, `forgot-password.test.ts`, `admin.test.ts` | Auth boundaries. |
| `server/tests/migrations.postgres.test.ts` | Checksum drift and partial-failure rollback. |
| `playwright.config.ts:24` | `retries: 1` in CI. Issue **#36** documents a cash-seam click-stability flake absorbed by that retry. Standard: a flake is deleted or fixed the day it is noticed. |
| `tests/e2e/zz-a-day-at-the-desk.spec.ts` | File order is load-bearing because of #34. Documented workaround, not a flake, but it means the suite is not isolated. |
| `docs/DEVELOPMENT.md` | “Assert deltas, not absolutes” — the suite still shares one demo tenant. Deterministic only if you know the order. |
| Missing | No eslint/format gate. No test that `/api/health` fails when Neon is down (because it does not). |

### §8 Review and CI — Partial

| Evidence | Why |
| --- | --- |
| `.github/workflows/{server,browser,governance}.yml` | PRs gate on typecheck, server tests + Postgres ledger, parse, generated-output freshness, full seam suite, living-docs freshness. |
| `.github/pull_request_template.md`, `CONTRIBUTING.md` | One job, stated end state, tests run, rollback. |
| Workflows are `on: [pull_request]` only | A push to `main` that bypasses a PR (or a broken merge) is not re-tested. Red-main-as-stop-the-line is a people rule, not a workflow. |
| No CODEOWNERS; `gh` rulesets list is empty | “Nothing reaches main without CTO review” is not enforced by GitHub from what this audit can see (branch-protection API returned 403 to the agent). |
| PR #30 | Still open, conflicting, last CI 2026-08-06 — pre-governance. A counter-example of “small, current, reviewed”. |

### §9 Architecture and operations — Partial

| Evidence | Why |
| --- | --- |
| `docs/PROJECT_STATE.md`, `docs/REPOSITORY_MAP.md`, `docs/ARCHITECTURE.md` | In-repo state exists and is CI-gated. Notion is a mirror (`docs/PROJECT_STATE.md` is the living one). |
| `server/src/app.ts:151` | `GET /api/health` → `{ ok: true, service: "currencydesk-server" }`. No DB ping. Render `healthCheckPath` (`render.yaml:39`) uses this. **Process-alive. Neon can be down and the probe stays green.** |
| `server/src/platform/health.ts` | The *real* dependency check (DB read + latency, email, Stripe, rates, storefronts) lives at `GET /api/admin/health` and requires a platform session (`server/tests/platform-ops.test.ts`). Load balancers never see it. |
| `render.yaml:31` | Free tier; sleeps after ~15 idle minutes. Documented, not a code defect. |
| Neon CU-hours | Ops, not code. Not declared as a budget in-repo. |
| `docs/ROAD_TO_DEPLOYMENT.md` | Stale issue-number collision (see §1). A stale state doc is worse than none; this one is dated and says so, but its “#31 / #33” now mean different GitHub issues. |

### §10 Sub-agents — N/A (process gaps only)

This audit is the CTO seat, not a product sub-agent. Noted gaps against
the standard’s process:

- No written slice brief template in the repo (end state, out of bounds,
  verification) beyond `AGENTS.md` + the PR template.
- Agents are told to open a PR; they are not told “Sol opens the slice
  first”. This audit itself was commissioned as a docs-only job, which
  matches the spirit.
- `AGENTS.md` already forbids inventing architecture and committing to
  `main`. That is the useful half.

### §11 Per-stack choices — Pass (recorded below)

Notion §11 already listed CurrencyDesk OS on 2026-09-04. The table at
the end of this document is the in-repo copy, with reasons taken from
the code and durable docs. One correction to carry back to Notion: the
public health endpoint does **not** check Neon; only `/api/admin/health`
does.

---

## Residual issues (verified, not fixed)

| ID | Verdict in code | Notes |
| --- | --- | --- |
| Seed demo `j.masri` / `yorkville` → 401 | **Ops, expected on a lived-in DB.** | `server/src/seed.ts` sets `yorkville` only on **first insert** (`onConflictDoNothing`). Production *requires* `SEED_PASSWORD` (`server/src/index.ts:24`). Once the row exists, the env var is ignored. A sit-down against the live desk is the Early Access → `/admin` invite → emailed code → `/onboarding/:code` path (`docs/ONBOARDING.md`). Seeded staff ids that are not emails still password-only (`auth.ts:122–129`). |
| #31 `PLATFORM_ADMIN_BOOTSTRAP` | **Confirmed.** | `admin-bootstrap.ts:30–31` updates `passwordHash` on every boot while the var is set. Comment tells the operator to remove it; nothing enforces that. |
| #32 Resend key | **Ops only.** | Not in the repo. Rotation cannot be proved from git. Leave open until an operator confirms. |
| #33 Platform MFA | **Confirmed.** | No TOTP/WebAuthn in `server/src/`. `/admin` is email + password (+ emailed code only if the staff id *is* an email). Cross-tenant blast radius. |
| #34 Multi-till `SCOPE_DENIED` | **Confirmed.** | Same fallback in `server/src/quotes/routes.ts:20`, `ledger/routes.ts:336`, `clients/routes.ts:134`: no `x-workspace-id` → “the only workspace at this branch” → `undefined` → `SCOPE_DENIED` once a second till exists. `zz-` seam prefix is the workaround. The OS *does* send the header (`os-src/cdos-backend.js`); a shop with two counters and any caller that does not is denied. |
| #36 cash-seam flake | **Confirmed as documented.** | `tests/e2e/cash-seam.spec.ts:85` — click on Reconcile & close races the till header. Passes alone; flakes in the full suite. Playwright `retries: 1` absorbs most occurrences. Not a financial assertion failure. |
| #35 YorkFX CDN tooling | **Closed, verified gone.** | No `unpkg` / Babel / `react.development` under `YorkFX/`. |
| Public `/CurrencyDesk OS.html`, `/admin.html` | **Confirmed still public.** | Allow-list in `app.ts:71–72`. Both load unpkg `react.development` + Babel standalone. Product routes do not. |
| `/onboarding` unpkg | **Confirmed residual.** | `design/onboarding/currencydesk-onboarding.html` and generated `web/onboarding.html` still list unpkg React production URLs in the bundler template. Marketing pages rewrite those to `/web/vendor/`. |
| `GET /api/health` | **Process-alive only.** | See §9. |
| PR #30 | **Park / close.** | `codex/lead-context-dossier`, title “Build a caller-safe lead dossier”. `CONFLICTING` vs `main`. Last CI 2026-08-06 (pre-governance). Conflicts include `docs/HANDOFF_GROWTH_PIPELINE.md`, deleted in #40. Outside the locked compiled-OS slice. Recommend: close as superseded / rebase-or-abandon; do not merge. Growth pipeline on `main` already has sourced research + ElevenLabs behind env flags (`docs/GROWTH_PIPELINE.md`). |
| Render free-tier sleep / Neon CU-hours | **Ops.** | `render.yaml:29–31`. Not a code change. |

---

## Top 10 gaps (severity: money / security / correctness first)

1. **Platform admin is one password deep, and boot can reset that password.** (#33 + #31). One phished or still-bootstrapped credential reaches every desk. `admin-bootstrap.ts` + no TOTP.
2. **Render health lies about Neon.** `GET /api/health` is `{ ok: true }`. A DB outage looks like a live shop until a person opens `/admin`. `app.ts:151`, `render.yaml:39`.
3. **Storefront SMS quotes and rate-board margins are floats.** Customer-visible amounts stored as `double precision` and computed with `*`. `public-site.ts:210–215`, `schema.ts:347–348, 647–649`.
4. **Quote-create still hard-codes CAD/USD/EUR/GBP** after the ledger learned every ISO 4217 code. A corridor the book will hold, the quote door will refuse. `quotes/routes.ts:15` vs migration 020.
5. **Multi-till resolution denies the second workspace.** (#34). Adding a till through the product’s own route breaks callers that omit `x-workspace-id`. Seam-test order is load-bearing.
6. **Hard-delete of a suspended desk destroys the audit trail.** `admin.ts:1415–1439` deletes `audit_events` and the 6-year record. Standard forbids this.
7. **Uncompiled Babel shells and `os-src/` are still on the public allow-list.** Residual XSS/supply-chain surface (`react.development`, in-browser Babel, Tailwind Play CDN on the editor shell). Not the product route; still fetchable.
8. **In-process auth challenges and cooldowns.** Sign-in codes die on every Render sleep. `auth.ts:74–76`, `cooldown.ts`.
9. **cash-seam flake tolerated by CI retry.** (#36). Standard says fix or delete the day it is noticed. Do not weaken the assertion.
10. **Two schema mechanisms + caret-ranged server deps + no secret-scan / `npm audit` job.** Drift between PGlite and Postgres; unpinned server libraries; #32 rotation still unconfirmed.

---

## Proposed slices

Each is work already named in the repo or this audit. Two-line end
states only — Sol opens, CTO does not invent the next one.

### Slice A — Multi-till resolution (#34)

A branch with two workspaces can post from both without `SCOPE_DENIED`.
The `zz-` prefix and its header comment are gone; seam file order is no longer load-bearing.

### Slice B — Platform MFA (#33)

A platform-operator sign-in requires TOTP (or stronger) in addition to the password.
Enrollment covers existing `platform_users`; tests match the `login2fa` standard.

### Slice C — Bootstrap is one-shot (#31)

`PLATFORM_ADMIN_BOOTSTRAP` creates a missing owner and never overwrites a password that already exists.
A boot with the var still set logs loudly and leaves the hash alone.

### Slice D — Health tells the truth

`GET /api/health` fails (non-200) when a trivial Neon read fails, and Render’s probe uses that behaviour.
`/api/admin/health` stays the narrative dashboard; the probe is the dependency check.

### Slice E — Quote door matches the book

`POST /api/quotes` accepts any currency the desk may hold; the four-way enum is gone.
A peso (or any stated) pair that the ledger will post, the quote service will quote.

### Slice F — Storefront holds are decimal

`rate_quotes` amounts/rates and board margins are `numeric`; the SMS quote path uses Decimal, once.
A hold a customer shows at the counter is a number the ledger can reproduce.

### Slice G — cash-seam is deterministic (#36)

`tests/e2e/cash-seam.spec.ts` “closing writes the counted figure back” passes in a full-suite run without Playwright retries.
No financial assertion is weakened.

### Slice H — Uncompiled shells leave the public internet

`/CurrencyDesk OS.html`, `/admin.html`, and `/os-src/*` are not on the production allow-list.
`/login`, `/app`, `/admin` still serve compiled `web/app/*` only.

---

## Deliberately not done — stay parked

These are real, and they are not this audit, and they should not be
opened as a side effect of reading it.

| Parked | Why it stays parked |
| --- | --- |
| PR #30 caller-safe lead dossier / ElevenLabs growth | Conflicts with `main`; pre-governance CI; growth already exists on `main` behind env flags. Close or rebase as its own later slice. |
| #32 Resend rotation | Ops. An operator confirms in Resend + Render; there is nothing to commit. |
| Render free-tier sleep; Neon CU-hours | Paid infra. Sol’s call. Not a PR. |
| Shop-Ready Core walkthrough | Named next priority in PROJECT_STATE. A proof, not a standards fix. Open only after A (multi-till) if the walkthrough would add a second till. |
| Three-decimal currency columns | `currencies.ts` refuses them on purpose. Widening ~47 `numeric(24,2)` columns is its own change. |
| ID / cheque images → object storage | Known (`docs/ROAD_TO_DEPLOYMENT.md`, #29 historically). Not a standards-audit job. |
| Authorization-as-hook | Named in ARCHITECTURE §8. Structural; do not sneak it into A–H. |
| One schema mechanism (DDL vs migrations) | Named in ARCHITECTURE §8. Do not “simplify” it inside another slice. |
| Compliance aggregate moving to the server | Browser still totals local rows for some compliance views. Two-books shape; its own slice, after the book is the only input. |
| Audit app reading `ledger_audit_events` | Screen still has a 300-item in-memory array (`ROAD_TO_DEPLOYMENT.md`). Examiner-facing; not this PR. |
| Vite / second frontend | Graveyard in `.github/workflows/browser.yml`. Do not propose. |
| Offline mode | Explicitly refused (`CASH_OWNERSHIP_INVARIANTS.md`). |
| Hard-delete / retention engine | Slice-shaped, but legal/counsel first (`SECURITY_COMPLIANCE_FOUNDATION.md`). Do not build a disposition engine from this audit. |
| Sub-agent process kit (brief template, slice register) | CTO/Sol process. Not product code. |

---

## §11 Per-stack choices currently in use

Recorded from the repo on 2026-09-04. Reasons are from the code or a
durable doc, not inferred taste.

| Choice | What | Reason (from the repo) |
| --- | --- | --- |
| Language / server | TypeScript, Node ≥22, Fastify 5, Zod | `server/package.json`; `docs/ARCHITECTURE.md` §2 — one origin, session cookies, no CORS. |
| Persistence (app) | Drizzle ORM + Postgres | Shape changes often; types matter (`ARCHITECTURE.md` §2). |
| Persistence (ledger) | Raw `pg`, hand-written SQL | Need `FOR UPDATE`, `SERIALIZABLE`, exact statements. Cost: no transaction spans both disciplines. |
| Dev database | Embedded PGlite | Zero install (`server/README.md`). Does **not** run SQL migrations — known debt. |
| Prod database | Neon Postgres via `DATABASE_URL` | `render.yaml`. Free-tier CU-hours are an ops limit, not a code choice. |
| Migrations | Checksummed SQL in `server/src/db/migrations/`, registered in `migrations.ts`, mirrored in `DDL` for Drizzle tables | `docs/MIGRATION.md`. Immutable once applied. |
| Money | `decimal.js` + `numeric(24,2\|12)` on the ledger | `CASH_OWNERSHIP_INVARIANTS.md`. Float is forbidden on the book; still present on SMS quotes and board margins (gap). |
| Frontend | Buildless React 18.3.1, compiled AOT to `web/app/` | Deleted Vite app was green while production went unwatched (`.github/workflows/browser.yml` header). |
| CSS | Tailwind 3.4.17, compiled to `web/app/tw.css` | CDN compiler is gone from what ships; only the editor shell still pulls it. |
| Browser deps | React, ReactDOM, Babel standalone, Tailwind **pinned exactly** | Root `package.json` comment: a caret would serve a version the committed `web/` was never built with. |
| Server deps | Caret ranges + lockfile | Weaker than the standard’s “pinned”. Overrides exist for a handful of CVEs. |
| Tests | vitest (server, `--no-file-parallelism`); Playwright seams; `check:parse` | Money changes require a seam (`CASH_OWNERSHIP_INVARIANTS.md`). Fresh DB per full run. |
| Deploy | Render Blueprint, auto-deploy `main`, free plan | `render.yaml`. One process, static + API. |
| Secrets | Render dashboard / `server/.env` (gitignored) | `ARCHITECTURE.md` §5. No secret manager, no workload identity. |
| Email | Resend, or log-if-unset | `server/src/email.ts`. Codes are logged when the key is missing — that is how e2e reads them. |
| Sessions | Opaque token, httpOnly, SHA-256 at rest, 12h TTL | `server/README.md`. Revocable; JWT refused on purpose. |
| Passwords | scrypt via `node:crypto` | No native deps; params stored in the hash so cost can rise later. |
| Formatting / lint | **None in CI** | No eslint/prettier/biome config. Typecheck + parse + tests are the gates. |
| Logging / errors | Fastify logger off in test; `console.warn` / `console.error` in prod | No central error reporter. Audit events are the business trail, not the ops trail. |
| Governance | `scripts/check-repository-governance.mjs` | Living docs cannot rot silently. |
| Generated output | `web/` and `web/app/` committed, CI-diffed | A deploy serves exactly what the sources say. Hand-edits are a reject. |

---

## What this audit did not change

No file under `server/`, `os-src/`, `web/`, `YorkFX/`, or any workflow.
No dependency bump. No merge. Issues #31–#36 are untouched.
`docs/PROJECT_STATE.md` is stamped only to record that this audit
happened and that the previous “last reviewed” line still pointed at
`90a3890` while `main` was already `f31cf21`.
