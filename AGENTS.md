# AGENTS.md — the canonical instruction set for this repository

Any AI coding agent (and any human) working in CurrencyDesk follows this
document. It is short on purpose. When another instruction file conflicts with
it, this one wins; when this one is wrong, fix it in the same PR that proves it
wrong.

## Start of every session — no exceptions

1. Read this file.
2. Read `docs/PROJECT_STATE.md` — what is true *now*. Never reason from old
   handoff documents or from memory of a previous session.
3. Read `docs/REPOSITORY_MAP.md` — what runs, where it lives, how it builds.
4. Read the domain document for the area you are changing (they are indexed in
   `docs/PROJECT_STATE.md`). Financial changes start at
   `docs/CASH_OWNERSHIP_INVARIANTS.md`.
5. Establish real git state — never assume it:

   ```bash
   git fetch origin
   git status --short --branch
   git branch -vv
   ```

## Branch discipline

- **Never commit to `main`.** Confirm you are not on it before editing.
- Start from fresh `origin/main` unless you are explicitly continuing an
  existing active PR's branch.
- **One coherent job = one branch = one PR.** Do not add unrelated work to an
  existing branch, yours or anyone else's.
- Name the branch for the work, not the tool:
  `feat/…`, `fix/…`, `security/…`, `test/…`, `chore/…`, `docs/…`,
  `release/…`, `hotfix/…` (rules and examples in `CONTRIBUTING.md`).
  No `claude/*`, `codex/*`, `agent/*`, session IDs, or `new`/`final`/`test2` names.
- Delete the branch after its PR merges.

## Before proposing an architecture

Inspect the existing implementation first. This codebase has already deleted
one parallel frontend that was built without looking; the graveyard is
documented in `.github/workflows/browser.yml`'s header. If your plan starts
with a new framework, directory, or second implementation of something that
exists, stop and re-read `docs/REPOSITORY_MAP.md`.

## Financial behaviour

Identify the authoritative server boundary **before** changing anything that
touches money:

- **One book.** The financial ledger is the server-side Postgres ledger
  (`server/src/ledger/`). The browser renders cash; it never computes it.
- The server owns identity: transaction references, obligation references,
  client IDs. **Never invent IDs in the browser.**
- A figure the ledger cannot answer renders as **absent, never zero**
  (`docs/ABSENT_FIGURES.md`).
- **Never weaken a financial test to make a PR green.** If a seam or ledger
  test fails, the finding is the deliverable; report it.
- Database migrations are **immutable once merged/applied** — never edit or
  rename one; add the next one. Adding a migration means three places —
  the full contract is `docs/MIGRATION.md`.
- **Never test against a production database.** Tests use embedded PGlite or a
  disposable local/CI Postgres.

## Testing

- Run the tests that cover the area **before and after** the change:
  - browser scripts: `npm run check:parse`
  - server: `cd server && npm run typecheck && npm test`
  - Postgres invariants: add `TEST_DATABASE_URL=postgres://…/freshdb`
  - browser↔server seams: `SEAM_DATABASE_URL=postgres://…/freshdb npm run test:e2e`
- **Use a fresh database per full run** — several suites deliberately leave
  ledger state behind.
- Test file order is currently load-bearing in the seam suite: the `zz-`
  prefix on `zz-a-day-at-the-desk.spec.ts` is a documented workaround for the
  multi-till resolution defect. Do not rename or reorder seam tests until that
  defect is fixed.

## Generated output

`web/` and `web/app/` are **generated. Never edit them directly.** Edit the
sources (`design/site/`, `CurrencyDesk Onboarding.html`, `os-src/` + the root
shells) and rebuild: `npm run build`. CI rejects stale generated output, and it
also rejects hand-edits, because they make the build dirty.

## Documentation duties — part of the change, not an afterthought

- Update `docs/PROJECT_STATE.md` when your change alters what is true about
  the product, its risks, or active work. If it doesn't, say so explicitly via
  the PR template's "reviewed — no change required" checkbox. CI enforces one
  or the other.
- Update any durable document your change makes inaccurate
  (`docs/REPOSITORY_MAP.md`, `docs/ARCHITECTURE.md`, `README.md`, domain docs).
- **Do not leave important findings only in a temporary handoff document.**
  Durable knowledge goes in the durable doc for its domain; unresolved
  problems become GitHub issues. Temporary handoffs are not an authoritative
  record of anything.

## Finishing

- Rebuild generated output where required; confirm `git status` is clean after
  `npm run build`.
- Open **one PR** for the one job, using the PR template honestly.
- Do not reuse the branch for the next job.

## Hard-won warnings (each of these cost this codebase real time)

- **A grep that finds nothing proves nothing.** Static HTML, generated output,
  dynamic routing, and indirect script loading all hide references. Trace the
  runtime path before declaring something unused.
- **Drive the browser/server seam when verifying wiring.** Every serious cash
  defect here survived green unit tests on both sides; only a seam test that
  drives the screen and then asks the ledger catches a handover bug.
- **Squash merges mean branch ancestry proves nothing** about whether work is
  represented on `main`. Compare patches (`git patch-id`), not ancestry.
- The static server serves from the repo root behind an allow-list
  (`server/src/app.ts`) — files can be runtime-critical without any code
  importing them. Check the allow-list and `render.yaml` before touching root
  files.
