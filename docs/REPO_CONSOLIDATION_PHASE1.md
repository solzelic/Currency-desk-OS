# Repository Consolidation — Phase 1 audit

Date: 2026-08-14 · Audited at `main` = `6704e8563c3e62030fd089083fe974c0f52365f3`
Status: **findings and proposal only — no deletions, merges, or branch removals have been performed.**
This file is the working document for the cleanup PRs that follow it, and should itself be
deleted when the cleanup completes (its durable content moves into the docs it proposes).

Every claim below was verified against the working tree, `git` history (unshallowed),
GitHub PR metadata, a clean `npm ci && npm run build`, and runtime configuration
(`render.yaml`, `server/src/app.ts`, `server/src/sites.ts`, `playwright.config.ts`,
`.github/workflows/*`). Nothing is classified from filename or grep alone.

---

## A. Current state

| Fact | Value |
| --- | --- |
| `main` SHA | `6704e8563c3e62030fd089083fe974c0f52365f3` — "Gate lead research on business identity (#29)", 2026-08-05 |
| Local checkout | matches `origin/main` exactly; clean working tree; no stashes; no extra worktrees; no tags |
| Tracked files | 389 |
| Remote branches | 21 besides `main` (plus `gh-pages`, which shares no history with `main`) |
| Open PRs | 3 — #30 (active), #5 (draft, obsolete), #4 (obsolete) |
| Merged PRs | 27 (#1–#29 minus the three open). **All were squash-merged**, so `ahead/behind` alone misleads; every branch below was verified by patch-id or ancestry |

**Important current workstreams**

1. **Growth pipeline** (lead research + outbound calling) — the only active line of work. PR #30 (`codex/lead-context-dossier`, Aug 6) extends it.
2. **Ledger workstream** — landed via PR #27; `docs/HANDOFF_LEDGER_WORK.md` documents the open items (esp. the `x-workspace-id` till-resolution defect, item #33).
3. **Unmerged, still-relevant work exists on one branch**: `claude/currencydesk-onboarding-completion-ls2i74` tip `cee9c74` (Aug 3) contains two code fixes that are **verifiably absent from `main` today**: (a) the sign-in code email (A3) still renders the undesigned plain fallback on `main` (`server/src/email.ts:75`); (b) a fake two-step screen with hardcoded code `000000` and a "Simulated" banner is still compiled into the customer OS bundle (`os-src/cdos-os.jsx:453`). See §F and §J.

---

## B. Canonical architecture (as it actually runs)

One Render web service (`render.yaml`): a Fastify + Drizzle server (`server/src/`)
that serves both the API and every static surface from the repository root
(`STATIC_DIR=..`), behind a strict public-asset allow-list (`app.ts:66`).
There is **no Vite, no bundler-built SPA** — that architecture was deleted;
`browser.yml`'s header commemorates it. The frontends are buildless React
(in-browser Babel) with an ahead-of-time compile step for production.

### Frontends (4 surfaces + hosted storefronts)

| Surface | Source (edit this) | Generated output (never edit) | Built by |
| --- | --- | --- | --- |
| Marketing site | `design/site/*.dc.html` + `support.js`, `image-slot.js` | `web/index.html`, `mobile.html`, `legal.html`, `faq.html`, `compliance.html`, `contact.html`, `early-access.html`, `web/support.js`, `web/image-slot.js`, `web/vendor/react*.js` | `scripts/build-site.mjs` |
| Onboarding | `CurrencyDesk Onboarding.html` (design bundle, repo root) | `web/onboarding.html` | `scripts/build-onboarding.mjs` (also runs in the Render `buildCommand`) |
| The OS | `CurrencyDesk OS.html` (shell) + `os-src/*.jsx` (all 30 files verified referenced) | `web/app/index.html`, `web/app/os.js`, `web/app/tw.css` | `scripts/build-os.mjs` |
| Admin panel | `admin.html` (shell + one inline Babel script) | `web/app/admin.html`, `web/app/admin.js` | `scripts/build-os.mjs` |
| Customer storefront | `YorkFX/` (served as-is; no build) | — | — |

`web/fonts/`, `web/photos/`, `web/assets/` are extracted **once** from designer
exports by `scripts/extract-design-assets.mjs` and committed; the day-to-day
build reuses them. `scripts/unbundle-design.mjs` converts a designer's
"standalone" export back into a buildable `.dc.html`.

**Generated output is committed deliberately and this is sound**: a clean
`npm ci && npm run build` reproduces the committed `web/` byte-for-byte (verified —
zero diff), and `browser.yml` fails CI if `web/` is stale. Render's build only
runs `build-onboarding`; production serves the committed compiled output, with
the hand-written shells as fallback if `web/app` is absent (`app.ts:201`).

### Route map (verified in `server/src/app.ts` and `sites.ts`)

| Route | Handler → file |
| --- | --- |
| `/` | UA-sniffed: `web/index.html` (desktop) / `web/mobile.html` (phone); `/d`, `/m` address each directly |
| `/signup` | `web/early-access.html` (Early Access application) |
| `/login`, `/app` (+ `/app/*` → 301 `/app`) | compiled OS `web/app/index.html`, fallback `CurrencyDesk OS.html` |
| `/admin` | compiled `web/app/admin.html`, fallback `admin.html` |
| `/onboarding`, `/onboarding/:code` | `web/onboarding.html` (invite code read from path) |
| `/legal` `/faq` `/compliance` `/contact` | generated `web/*.html`; `/add-ons` is registered but its page is not yet designed — link falls back to `#pricing` (by design; harmless) |
| `/sites/yorkfx/*` | whole `YorkFX/` dir; index `YorkFX Homepage.html`; shared `../yorkfx-converter.js` + `../yorkfx.css` served at `/sites/<file>`; customer custom domains rewritten via Host header (`rewriteUrl`) |
| `/YorkFX/*`, `/os-src/*`, `/web/*`, `/assets/*`, the two shells, `yorkfx.css`, `yorkfx-converter.js` | static allow-list (the Rate Board iframe inside the OS loads `/YorkFX/YorkFX Rate Board.html`) |
| `/api/*` | Fastify routes: auth, signup, enquiries, early-access, pin, staff, desk, tenant, tenant-state, admin, growth, onboarding-public, public-site, rates, billing — plus, **only when a database URL is configured**: ledger, quotes, clients (44+ ledger routes) |
| 404 handling | pages fall back to site/OS by `Sec-Fetch-Dest`; assets get a real 404 (deliberate, tested) |

### Data layer

- App data: Drizzle ORM over PGlite (embedded, dev/test) or Postgres (`DATABASE_URL`).
- Ledger: raw SQL, checksummed migrations `server/src/db/migrations/001–022`, plus
  `server/src/ledger/migration.sql` for the base ledger tables. Append-only book;
  invariants documented in `docs/CASH_OWNERSHIP_INVARIANTS.md` (the canonical financial doc).
- Two schema mechanisms (boot-time DDL + migrations) coexist — known, documented in `ARCHITECTURE.md` §8.

### Test hierarchy (what each layer proves)

| Layer | What | Runs in CI? |
| --- | --- | --- |
| Parse gate | `scripts/check-browser-parses.mjs` — every browser script parses | ✅ browser.yml |
| Staleness gate | rebuild + `git diff --exit-code -- web/` | ✅ browser.yml |
| Server unit/integration | 48 vitest files on embedded PGlite (auth, tenancy, funnel, comms, rates, state store…) | ✅ server.yml |
| Postgres invariants | 22 `*.postgres.test.ts` (ledger, quotes, vault, cost basis, FIFO, obligations, cheques, thresholds, jurisdictions, client records) — `describe.skip` without `TEST_DATABASE_URL` | ✅ server.yml (plus a second, fresh DB for the focused ledger gate) |
| Browser seam tests | 17 Playwright specs against the real server; 13 need `SEAM_DATABASE_URL` | ⚠️ **only 3 run in CI** (`customer-journey`, `growth-pipeline`, `id-intake-seam`). The deployment gate `zz-a-day-at-the-desk.spec.ts` **never runs in CI** — see §J |

The `zz-` filename prefix is a documented workaround (ordering the shift last)
for the till-resolution defect (#33) — **preserve it** until that defect is fixed.

---

## C. Canonical directory tree (proposed; after cleanup)

Consolidation, not redesign. The working architecture stays exactly as it is;
what changes is that everything on disk is one of: source, generated output,
design source, customer implementation, tests, or durable docs.

```
├─ README.md                     accurate front door (fixed; Vite section removed)
├─ package.json / package-lock.json / .nvmrc / .gitignore
├─ render.yaml                   deployment blueprint
├─ playwright.config.ts
├─ CurrencyDesk OS.html          OS shell (source + prod fallback)   [rename deferred — §E]
├─ CurrencyDesk Onboarding.html  onboarding design bundle (build input) [relocation deferred — §E]
├─ admin.html                    admin shell (source + prod fallback)
├─ yorkfx.css / yorkfx-converter.js   shared storefront runtime (repo root by served-path contract)
├─ os-src/                       OS source — 28 .jsx + backend/persist + york-os.css
├─ web/                          GENERATED site + compiled apps + committed extracted assets
├─ design/
│  ├─ site/                      marketing design sources (.dc.html + runtime)
│  ├─ emails/                    email design source
│  └─ kyc-handoff/               (moved from design_handoff_kyc/ + "KYC Nudge States.html")
├─ YorkFX/                       customer storefront implementation (pruned of orphans)
├─ scripts/                      build + design-import tools (all 8 current)
├─ server/                       Fastify backend, migrations, server tests
├─ tests/e2e/                    Playwright seam suite
└─ docs/                         the durable set only — see §H
```

Directories with **mixed responsibilities today** (all resolved by the moves above,
none requiring code changes except §E's deferred items):

- Repo root: runtime files + two design artifacts (`KYC Nudge States.html`, `onb-desktop.png`) + a design bundle. → root keeps only runtime/build-contract files.
- `docs/`: 11 durable engineering docs interleaved with 6 session handoffs, 3 dead docs, and a designed HTML roadmap.
- `design_handoff_kyc/`: design material living outside `design/`.
- `YorkFX/`: served product + orphaned wireframe/design leftovers and ~5.8 MB unreferenced media.

---

## D. Deletion manifest

Nothing here has been deleted. Risk legend: evidence quality for "deletion is safe".

### D1. Obsolete architecture (in-tree)

The Vite/TS app is already gone from `main`; in-tree remnants are only these:

| Path | Why it exists | Why obsolete | Evidence | Risk |
| --- | --- | --- | --- | --- |
| `YorkFX/YorkFX Wireframes.html` | design-phase wireframes (V1 prototype commit, 2026-07-10) | not part of the served storefront | no nav link from any served page; loads `tweaks-app.jsx` which **does not exist** — the page is already broken | LOW |
| `YorkFX/wireframe.css` | styles for the above | only consumer is the orphaned wireframes page | single reference: `YorkFX Wireframes.html:7` | LOW |
| `YorkFX/yorkfx-staff.css` | old Rate Board stylesheet | superseded 2026-07-13 when the board's styles were inlined | zero references repo-wide; `YorkFX Rate Board.html` has no `<link rel=stylesheet>`; carries selectors `yorkfx-staff.js` no longer emits | LOW |

### D2. Duplicates

| Path | Duplicate of | Evidence | Risk |
| --- | --- | --- | --- |
| `YorkFX/assets/engraving-callout.jpg` (308 KB) | `YorkFX/assets/engraving-detail.jpg` | byte-identical (md5 `ad60456d…`); only `engraving-detail` is referenced (Regulations:74) | LOW |
| `design/emails/support.js` (69 KB) | `design/site/support.js` | byte-identical (md5 `951ae391…`); sole consumer is the email design opened standalone — replace its `src` with `../site/support.js` in the same commit | LOW |

### D3. Scratch / session artifacts

| Path | Why it exists | Why obsolete | Evidence | Risk |
| --- | --- | --- | --- | --- |
| `onb-desktop.png` (1.4 MB, repo root) | screenshot render of the old onboarding design | superseded design | zero references from any HTML/script/server file; two docs explicitly call it "a render of the old design" (`ONBOARDING-HANDOFF.md:181`, `NEXT-AGENT-PROMPT.md:120`) | LOW |

(Working-tree scratch — `test-results/`, `playwright-report/`, `_scratch_*` — is
already properly gitignored; none is tracked. `git ls-files` contains no
copy/backup/final/numbered-duplicate patterns.)

### D4. Generated clutter

None. All of `web/` is either reproducible generated output (verified byte-exact)
or committed-on-purpose extracted assets, and CI enforces freshness. Every file in
`web/photos/`, `web/assets/`, `web/fonts/` is referenced by the generated pages.

### D5. Dead tests

None. All 58 server test files and 17 e2e specs target current architecture.
(Two config files carry stale *comments* about the deleted Vite app —
`server/vitest.config.ts`, `playwright.config.ts` headers; fix the comments, keep the files.)

### D6. Dead configuration

None found. Both workflows are current; all root and server dependencies are
imported/used (verified per-package); every npm script is live; the `overrides`
block is security pins. The only dead references are in documentation (§H).

### D7. Dead assets (unreferenced, publicly fetchable under `/sites/yorkfx/assets/`)

Zero references in any HTML, CSS, JS, build script, or server file:

| Path | Size | Risk |
| --- | --- | --- |
| `YorkFX/assets/banknote-mouths.jpg` | 731 KB | LOW-MED* |
| `YorkFX/assets/dollar-chart.jpg` | 449 KB | LOW-MED* |
| `YorkFX/assets/engraving-eye.jpg` | 260 KB | LOW-MED* |
| `YorkFX/assets/money-rotate.mp4` | 1.0 MB | LOW-MED* |
| `YorkFX/assets/storefront.jpg` | 1.9 MB | LOW-MED* |
| `YorkFX/assets/yorkville-day.jpg` | 88 KB | LOW-MED* |
| `YorkFX/assets/yorkville-garden.jpg` | 207 KB | LOW-MED* |
| `YorkFX/assets/yorkville-night.jpg` | 439 KB | LOW-MED* |
| `YorkFX/assets/yorkville-plaque.jpg` | 404 KB | LOW-MED* |

\* MED only because these URLs are live on a customer's public storefront host and
could in principle be hot-linked from outside the repo (nothing in-repo can prove
otherwise). Mitigation: git history retains them; restore is one revert. Recommend
deleting after a quick check of production access logs, or accept the tiny risk.

### D8. Stale documentation (delete; unique knowledge extracted per §H)

| Path | Verdict | Evidence in one line | Risk |
| --- | --- | --- | --- |
| `docs/DEVELOPMENT.md` | delete | instructs `npm run dev` + Vite + `frontend.html`; none exist | LOW |
| `docs/MIGRATION.md` | delete (reuse filename for the real DB-migration rule) | "Frontend Migration Plan" to the deleted Vite target | LOW |
| `docs/SAAS_ROADMAP.md` | delete | Phases A–D described as future are all shipped (`signup.ts`, `tenantState.ts`, migration `007`…) | LOW |
| `docs/CurrencyDesk OS - Roadmap v2.html` | delete (git is the archive) | superseded by `ROAD_TO_DEPLOYMENT.md`; its own build queue is annotated resolved | LOW |
| `docs/HANDOFF.md` | delete after extracting JSX/PGlite gotchas | claims "source of truth", 3 weeks stale, "expect 69 passing" vs ~680 tests now | LOW |
| `docs/NEXT-AGENT-PROMPT.md` | delete after extracting sandbox notes | copy-paste prompt for a finished session; its "landmine" (build-onboarding not in `npm run build`) is fixed | LOW |
| `docs/NEXT-PUSH.md` | delete after extracting the `{{ p.src }}` 404 rationale | walked-findings report whose P0s are shipped | LOW |
| `docs/HANDOFF_GROWTH_PIPELINE.md` | delete after merging §2 (stated-vs-inferred provenance) into `GROWTH_PIPELINE.md` | all three stages marked implemented; `GROWTH_PIPELINE.md` is the successor | LOW |
| `docs/HANDOFF_LEDGER_WORK.md` | delete **only after** §2, §5, §6 move (§H) | handoff for merged PR #27, but carries the best build/test/migration/traps knowledge in the repo | MED (until extraction) |
| `docs/EMAIL-BUILD.md` | delete after extracting email-HTML constraints + sending env | its "A4 does not exist" is false (`comms.ts:244`) | LOW |

### D9. Other

| Path | Action | Reason | Risk |
| --- | --- | --- | --- |
| `KYC Nudge States.html` (root) | **move**, don't delete → `design/kyc-handoff/` | referenced as "standalone reference" by `design_handoff_kyc/README.md`; not servable (not on the allow-list), not built | LOW |

Not proposed for deletion despite looking like candidates: `CurrencyDesk OS.html`,
`admin.html`, `yorkfx.css`, `yorkfx-converter.js` (runtime allow-list + fallbacks +
build inputs), all of `web/` (CI-gated generated output), `YorkFX/tweaks-panel.jsx` +
`homepage-tweaks.jsx` (loaded by all five live storefront pages — removing them is a
product change, flagged in §J, not cleanup), `server/tests/fixtures/migrations/*.sql`
(used by `migrations.postgres.test.ts`).

---

## E. Rename manifest

### SAFE_NOW (no runtime path touches them)

| Old | New | Reason | Runtime impact | Risk |
| --- | --- | --- | --- | --- |
| `design_handoff_kyc/` | `design/kyc-handoff/` | all design material under `design/` | none — nothing serves or builds it (fix the stale §1 paths in its README in the same commit) | LOW |
| `KYC Nudge States.html` | `design/kyc-handoff/kyc-verification-states.html` | design reference beside its handoff | none — not on the static allow-list | LOW |
| `docs/ONBOARDING-HANDOFF.md` | `docs/ONBOARDING.md` (trimmed) | it is the only real onboarding reference; stop it looking disposable | none | LOW |
| `server/src/clients/records.ts` NUL bytes | replace 2 literal `\x00` bytes with `" "` escapes | file currently reads as binary to grep/git tooling | none (same string value; covered by `client-records.postgres.test.ts`) | LOW |
| stale comments: `server/vitest.config.ts` ("frontend's vite.config.ts"), `playwright.config.ts` + `browser.yml` headers | rewrite comment text | they narrate deleted architecture | none | LOW |

### DEFER (runtime-sensitive; do together in Cleanup PR 3, or not at all)

| Old | New (proposed) | Why deferred |
| --- | --- | --- |
| `CurrencyDesk OS.html` | `os-shell.html` | referenced by `render.yaml` (`STATIC_INDEX`), `app.ts` allow-list + `compiled()` fallback, `build-os.mjs`, `server/package.json` `dev:prototype`, `static-routing.test.ts`, `serves-compiled.test.ts`, README. One coordinated commit; deploy-config change on Render required. Value: kills the most-quoted spaced filename. |
| `CurrencyDesk Onboarding.html` | `design/onboarding/currencydesk-onboarding.html` | build input only (`build-onboarding.mjs:52`) **but** the Render `buildCommand` runs that script on deploy — script + render.yaml must move together |
| `admin.html` | keep as-is | fallback + build-input contract; the name is already honest and short |
| `server/src/routes/tenantState.ts` | `tenant-state.ts` | only intra-server imports; cosmetic — batch with PR 3 or skip |

**Branch naming (forward-looking policy, not a rename):** adopt
`feat/ fix/ security/ test/ chore/ docs/ release/ hotfix/` prefixes as specified.
Existing `claude/*`, `codex/*`, `agent/*`, `develop/*` branches are dispositioned in §F,
not renamed. First uses: `chore/repository-consolidation-1`, `security/remove-fake-otp-screen`.

### Domain terminology

| Term set | Finding | Class |
| --- | --- | --- |
| `desk` vs `tenant` | Two registers for one concept, used consistently: `tenant` = DB/infra (`tenants` table), `desk` = product voice. Renaming either is DB/API surgery for zero behaviour. | DO_NOT_CHANGE — document in glossary |
| `till` vs `workspace` vs `drawer` | Genuinely distinct: `workspace` = ledger scoping unit (`x-workspace-id`, `workspaces` table), `till` = the physical till (`till_id`), `drawer` = the cash in an open till session. The confusion is real (defect #33 lives exactly here) but the fix is the defect fix, not a rename. | DO_NOT_CHANGE — glossary + fix #33 |
| `client` (`desk_clients`) vs `customer` (`ledger_customers`) | Two tables, two lifecycles (KYC file vs ledger counterparty), joined deliberately (`clients/routes.ts`). `docs/CLIENT_RECORDS.md` explains why. Unifying is a schema migration. | FUTURE_MIGRATION (candidate, not urgent) |
| `deal` / `trade` / `transaction` | `ledger_transactions` is canonical storage; `deal_kind` is a real column; UI says "deal". Mostly consistent register split; the drift is in prose. | SAFE_NOW: glossary entry; DO_NOT_CHANGE columns/APIs |
| `enquiry` / `application` / `lead` | `enquiries` = every inbound (contact + early-access); an early-access enquiry is an "application" in the funnel; growth research turns it into a "lead". Sequential states, not synonyms. | SAFE_NOW: glossary entry |

SAFE_NOW deliverable: a short **Glossary** section in `docs/ARCHITECTURE.md`
(or `docs/GLOSSARY.md`) pinning the five rows above.

---

## F. Branch cleanup manifest

All merged PRs were **squash merges**, so nothing shows as merged by ancestry alone.
Method: patch-id equality between the branch's cumulative diff and its squash commit,
or strict ancestry (`ahead=0`). "Represented" = the branch's entire content is on `main`.

| Branch | Head | Last | PR | Represented on main? | Class | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `agent/harden-production-static-serving` | `ea3cfdc` | 07-28 | #9 merged | ✅ ancestor of main (`ahead=0`) | MERGED_DELETE | strict ancestor |
| `agent/server-authoritative-quotes` | `d255aa0` | 07-28 | (folded into #7) | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `claude/currencydesk-onboarding-completion-ls2i74` | `cee9c74` | 08-03 | #11–#26 all merged | ❌ **1 commit past the #26 squash, never merged** | **UNMERGED_REVIEW** | contains 2 code fixes still absent from main (A3 designed email; removal of fake `000000` 2FA screen) + a docs-truth pass. Cherry-pick the code fixes (see §K); the docs portion is superseded by this audit |
| `claude/faster-first-paint-ls2i74` | `712a2ca` | 07-31 | (dup of #24) | ✅ patch-id identical to merged `2d48e54` | MERGED_DELETE | byte-equal patch |
| `claude/login-signup-process-pibvxw` | `168f8d2` | 07-28 | — | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `claude/till-wiring-money-flow-garwho` | `126965c` | 08-05 | #27 merged | ✅ 9-commit chain patch-id == squash `715668e` | MERGED_DELETE | byte-equal patch |
| `codex/lead-context-dossier` | `857bc20` | 08-05 | **#30 OPEN** | ❌ (that's the point) | **KEEP_ACTIVE** | live growth work, based on current main |
| `codex/relevant-lead-research` | `0699619` | 08-05 | #29 merged | ✅ tree-identical for touched files | MERGED_DELETE | squash `6704e85` |
| `codex/tavily-error-diagnostics` | `d4cb6de` | 08-05 | #28 merged | ✅ patch-id == squash `a2ceab4` | MERGED_DELETE | byte-equal patch |
| `design-sync/prototype-refresh` | `12d81a0` | 07-12 | — | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `develop/backend-auth-tenancy` | `69a6be0` | 07-12 | — | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `develop/frontend-foundation` | `f0ff21c` | 07-11 | #1 merged | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `develop/ledger-backend-foundation` | `d0b4310` | 07-13 | #6 merged | ✅ same file set; squash differs only by a dep-manifest tweak made at merge (tsx → dependencies, engines field) — main's version is the superset | MERGED_DELETE | verified content diff |
| `develop/product-blueprint-and-visual-shell` | `520c7ba` | 07-12 | **#5 OPEN draft** | ❌ but targets deleted architecture | **OBSOLETE_DELETE** (close #5 first) | 8 commits of Vite-era visual shell (`src/App.tsx`, `vite.config.ts`, browser snapshots) + an early ledger service superseded by PR #6/#7 line. Docs it adds (blueprint, permission matrix…) describe the deleted shell |
| `develop/quote-service-foundation` | `06ea842` | 07-15 | #7 merged | ✅ ancestor | MERGED_DELETE | strict ancestor |
| `develop/security-compliance-foundation` | `c2fc980` | 07-11 | #3 merged | ✅ chain patch-id == squash `0c9072f` | MERGED_DELETE | byte-equal patch |
| `develop/validate-vertical-slice` | `89a987e` | 07-11 | #2 merged | ✅ except 1 commit == the obsolete Vite-entry fix (identical patch to `fix/root-vite-entry`) | OBSOLETE_DELETE | the only unmerged commit patches root `index.html`, deleted with the Vite app |
| `fix/root-vite-entry` | `def30c9` | 07-11 | **#4 OPEN** | ❌ but patches a file that no longer exists | **OBSOLETE_DELETE** (close #4 first) | fixes the Vite entry `index.html`; architecture removed |
| `gh-pages` | `0fe45ba` | 07-12 | — | n/a (no shared history) | **SPECIAL — decide** | GitHub Pages publish of the July-12 prototype demo (526 files incl. old standalone exports). Almost certainly obsolete, but it is a *published site*; confirm nothing external links it, then delete the branch and disable Pages |
| `revert-1-develop/frontend-foundation` | `7e91002` | 07-11 | — | ❌ unused revert | OBSOLETE_DELETE | GitHub-UI revert branch never PR'd; the architecture it reverts is gone anyway |
| `solzelic-marketing-site` | `22a787b` | 07-26 | #8 merged | ✅ chain patch-id == squash `bcff001` | MERGED_DELETE | byte-equal patch |

Tally: **15 MERGED/OBSOLETE_DELETE (hard evidence) · 1 KEEP_ACTIVE · 1 UNMERGED_REVIEW · 1 SPECIAL (gh-pages)**.

---

## G. PR cleanup manifest

| PR | Branch | State | Recommendation |
| --- | --- | --- | --- |
| **#30** "Build a caller-safe lead dossier" | `codex/lead-context-dossier` | open, current (Aug 6), +239/−16 on growth files | **Do not touch.** Review/merge through the normal process |
| **#5** "Build CurrencyDesk product blueprint and visual shell" | `develop/product-blueprint-and-visual-shell` | open **draft** since Jul 12 | **Close without merging** — every file it touches belongs to the deleted Vite architecture (`src/App.tsx`, `vite.config.ts`, browser snapshots). Unambiguous under the "targets removed architecture" rule; the closing comment should say exactly that |
| **#4** "Fix root Vite entry and local launch" | `fix/root-vite-entry` | open since Jul 11 | **Close without merging** — patches root `index.html`, which no longer exists on main |

---

## H. Documentation consolidation

### Final canonical set (17 files, from 31 + 4)

```
README.md                                  (fixed: Vite track removed, security block re-pointed, doc index updated)
server/README.md                           (fixed: lines 1–46 rewritten, "Next slices" removed; keep the migration-checksum contract)
docs/ARCHITECTURE.md                       governing doc (rewrite §8 + header; add Glossary; absorb "a grep that finds nothing proves nothing")
docs/REPOSITORY_MAP.md                     NEW — §B/§C of this report made durable (what runs, where it lives, how it builds)
docs/CASH_OWNERSHIP_INVARIANTS.md          keep as-is (canonical financial invariants; add §6 seam-test index from the ledger handoff)
docs/ABSENT_FIGURES.md · COST_BASIS.md · CLIENT_RECORDS.md · CHEQUE_CASHING.md ·
docs/OBLIGATION_LINES.md · DESK_THRESHOLDS.md · DESK_CURRENCIES.md ·
docs/GENERATED_DOCUMENTS.md · JURISDICTION_PACK_ARCHITECTURE.md   keep as-is (the excellent Aug 03–05 cluster)
docs/LEDGER_POSTING_API.md                 keep; delete falsified "not yet cut over" limitation; note 44-route reality
docs/LEDGER_POSTING_INVARIANTS.md          keep; one-line home-currency amendment
docs/QUOTE_INVARIANTS.md + QUOTE_SERVICE.md keep; fold in cross-currency amendment; delete falsified closing paragraphs
docs/GROWTH_PIPELINE.md                    keep; absorb provenance reasoning from HANDOFF_GROWTH_PIPELINE §2
docs/STRIPE_BILLING.md                     keep as-is
docs/ONBOARDING.md                         promoted from ONBOARDING-HANDOFF.md (strip "Next"/"Still outstanding")
docs/ROAD_TO_DEPLOYMENT.md                 keep, date-stamp the title
docs/THREAT_MODEL.md                       keep substance; rewrite scope (currently scoped to deleted adapters)
docs/SECURITY_COMPLIANCE_FOUNDATION.md     keep substance; rewrite "Architecture Boundary" + gaps list; fold retention conflict into CLIENT_RECORDS
docs/MIGRATION.md                          REUSED NAME — the real three-places-to-add-a-migration rule + checksum contract (from ledger handoff §2 / server README)
docs/CONTRIBUTING.md (or DEVELOPMENT.md)   NEW, small — buildless-JSX traps, PGlite two-process warning, sandbox/browser notes (rescued from HANDOFF.md + NEXT-AGENT-PROMPT.md), test-fixture rules (assert deltas; fresh DB per seam run)
design/kyc-handoff/{README,BRAND,MOTION,WHOLESALE_MARKETPLACE}.md   moved; README §1 paths fixed, §5 marked superseded
```

### Deleted (after the extractions named in §D8)

`DEVELOPMENT.md` (old), `MIGRATION.md` (old content), `SAAS_ROADMAP.md`,
`CurrencyDesk OS - Roadmap v2.html`, `HANDOFF.md`, `NEXT-AGENT-PROMPT.md`,
`NEXT-PUSH.md`, `HANDOFF_GROWTH_PIPELINE.md`, `HANDOFF_LEDGER_WORK.md`, `EMAIL-BUILD.md`
→ 10 files out, all knowledge either already superseded or moved to a named home above.

Two items in stale handoffs must become **tracked issues before the files are deleted**:
(1) `PLATFORM_ADMIN_BOOTSTRAP` re-asserting the `12345` admin password on every boot until removed;
(2) rotating the Resend API key. Both appear in three separate handoffs today.

---

## I. Build and dependency cleanup

**Verdict: unusually clean. No deletions proposed.**

- Root `package.json`: 5 devDependencies, all load-bearing (`react`/`react-dom`/`@babel/standalone` pinned exactly for the vendored/compiled output — the manifest documents why; `tailwindcss` for `build-os`; `@playwright/test` for e2e). All 8 npm scripts live.
- `server/package.json`: every dependency imported (verified per-package); `tsx` is the runtime launcher (`start`/`dev`); `overrides` are security pins. All 9 scripts live (`seed`, `ledger:seed`, `ledger:migrate` are operational tools documented in server README).
- CI: both workflows current; no dead jobs. The dead Vite workflow was already removed (browser.yml's header documents it).
- `scripts/`: all 6 `.mjs` + `tailwind.config.cjs` + `tw-input.css` are in the build/design-import path.
- Cosmetic only: stale comments naming the deleted Vite app in `server/vitest.config.ts` and the `playwright.config.ts` / `browser.yml` headers (§E SAFE_NOW).

---

## J. Risks and unknowns

1. **The deployment gate does not run in CI.** `browser.yml` never sets `SEAM_DATABASE_URL`, so 13 of 17 Playwright specs — including `zz-a-day-at-the-desk`, the declared ship gate — silently skip. The financial seam suite is a manual, local-only gate today. Recommend a CI job with a Postgres service + `SEAM_DATABASE_URL` (fresh DB per run, as the ledger handoff instructs) **before** any runtime-touching cleanup phase, so cleanup PRs are graded by the real gate.
2. **Security: the fake 2FA screen ships today.** `os-src/cdos-os.jsx:453` still compiles a "Simulated: demo code is 000000" screen into the customer bundle; the fix exists unmerged on `cee9c74`. Cherry-pick promptly (it's small: that screen + A3 email routing through `codeEmail`).
3. **Unverifiable externally from the repo:** whether anything links the `gh-pages` demo site, and whether the 9 orphaned YorkFX assets are hot-linked by anyone outside the repo. Both are one-revert restorable; check Pages settings/analytics and access logs if available.
4. **Design tooling on live customer pages:** all five YorkFX storefront pages load `tweaks-panel.jsx` + `homepage-tweaks.jsx` and with them React *development* builds + Babel from unpkg. Removing them changes a customer-facing page → product decision, deliberately **out of scope** for cleanup; flagged for the next engineering push. Same for `YorkFX/image-slot.js` being the unpatched design-time copy that 404s on `.image-slots.state.json` every page load (the exact bug `build-site.mjs` patches out for `web/`).
5. **Known product defect #33** (till resolution: "the only workspace at this branch" + missing `x-workspace-id` denial) makes test order load-bearing (`zz-` prefix, fixture contamination notes). Cleanup must not rename or reorder seam tests until it's fixed.
6. **Platform MFA absent** (`ARCHITECTURE.md` §8 item 6) — confirmed still true; the repo's own docs call it the largest unpriced risk. Not a cleanup item; must not get lost when handoffs are deleted.
7. Squash-merge history means **`git cherry`/ancestry can never prove representation for future branches either** — the patch-id method used here should be repeated for any branch created before deletion day that isn't in this manifest.

## K. Recommended execution sequence

Each step is small, reviewable, and independently revertible. Steps 0–1 can start immediately after sign-off on this report.

- **Step 0 — out-of-band (no PR):**
  - Close PR #4 and PR #5 with the one-line rationale from §G.
  - Delete the 15 MERGED/OBSOLETE_DELETE branches (§F). Keep `codex/lead-context-dossier`, `claude/currencydesk-onboarding-completion-ls2i74` (until Step 2 lands), and `gh-pages` (until the Pages check).
  - Open the two security issues from §H.
- **Cleanup PR 1 — `chore/repository-consolidation-1` — deterministic low-risk deletions.**
  §D1 + §D2 + §D3 + §D7 (files only; ~7.5 MB), the `design/emails` `src` repoint, the §E SAFE_NOW comment fixes and NUL-byte fix. No behaviour change; graded by full CI.
- **Cleanup PR 2 — `security/remove-fake-otp-screen` (cherry-pick from `cee9c74`).**
  The two code fixes (fake 2FA screen removal; A3 → `codeEmail`), re-applied against current `main` (its `web/app/os.js` must be rebuilt, so the build gate proves freshness). Then delete the branch.
- **Cleanup PR 3 — `docs/consolidation` — documentation.**
  §H in full: 10 deletions with extractions, 2 rewrites, promotion, new `REPOSITORY_MAP.md`, `MIGRATION.md` (new content), `CONTRIBUTING.md`, glossary, README/server-README fixes. Also moves `design_handoff_kyc/` → `design/kyc-handoff/` and `KYC Nudge States.html` with it (pure moves, nothing references the old paths at runtime).
- **Cleanup PR 4 — `test/seam-suite-in-ci`.**
  Add the `SEAM_DATABASE_URL` job to browser.yml (fresh Postgres per run). Do this before PR 5 so the runtime-sensitive phase is graded by the real gate.
- **Cleanup PR 5 — `chore/repository-consolidation-2` — runtime-sensitive renames (optional).**
  §E DEFER block: `CurrencyDesk OS.html` → `os-shell.html`, onboarding bundle → `design/onboarding/`, coordinated across `render.yaml`, `app.ts`, build scripts, tests, READMEs. Skip if the Render coordination isn't worth it right now; everything else above stands alone.
- **Afterwards:** decide `gh-pages` (§J3), then delete this file once its content lives in `REPOSITORY_MAP.md` and the cleanup PRs are merged.
