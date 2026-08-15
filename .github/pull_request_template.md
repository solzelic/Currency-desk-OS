<!-- One job = one branch = one PR. See CONTRIBUTING.md and AGENTS.md. -->

## Checklist

- [ ] One coherent scope — nothing unrelated is included
- [ ] Started from current `origin/main`
- [ ] Relevant tests added or updated
- [ ] Required tests pass (say which suites in Validation below)
- [ ] Generated output rebuilt (`npm run build`) — if this PR touches `design/`, `os-src/`, the root shells, or build scripts
- [ ] No production secrets or production data used anywhere

**Living documentation** (CI checks one box per pair — see `scripts/check-repository-governance.mjs`):

- [ ] `docs/PROJECT_STATE.md` updated in this PR
- [ ] PROJECT_STATE reviewed — no change required
- [ ] Architecture/repository docs updated in this PR (`docs/REPOSITORY_MAP.md`, `docs/ARCHITECTURE.md`, `README.md`, `CONTRIBUTING.md`)
- [ ] Architecture docs reviewed — no change required

## Problem

<!-- What is wrong or missing, in product terms. -->

## What changed

## What did not change

<!-- Deliberate non-goals; adjacent things left alone on purpose. -->

## Validation

<!-- Suites run and against what database, e.g.
     server: typecheck + npm test (PGlite) + TEST_DATABASE_URL postgres
     browser: check:parse; SEAM_DATABASE_URL seam suite -->

## Documentation

<!-- Which docs changed and why — or why none needed to. -->

## Risk / rollback

<!-- Operational risk of merging; how to roll back if it goes wrong. -->
