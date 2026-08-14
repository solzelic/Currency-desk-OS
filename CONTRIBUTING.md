# Contributing to CurrencyDesk

The branch model is deliberately simple:

```
main  +  one temporary branch per active job
```

No permanent development branches. No branch jungles. AI agents follow
`AGENTS.md`, which incorporates everything here.

## The branch rule

**One job = one branch = one PR.** A branch exists for one coherent piece of
work, gets one PR, and is deleted after merge. Never keep adding unrelated
work to an existing branch because it happens to be checked out.

Allowed prefixes for new branches:

```
feat/      fix/      security/   test/
chore/     docs/     release/    hotfix/
```

Examples:

```
feat/remittance-status-lifecycle
fix/ledger-multi-till-resolution
security/platform-mfa
test/fresh-tenant-shift
chore/repository-cleanup
docs/update-ledger-architecture
release/massoud-pilot-1
```

Not acceptable for new branches: `claude/*`, `codex/*`, `agent/*`,
`develop/*`, `new/*`, `test123`, or random session IDs. Existing historical
branches keep their names until they are deleted; new work describes the work,
not the tool that performed it.

## Main

- Do not work directly on `main`.
- Refresh from `origin/main` before starting new work
  (`git fetch origin && git checkout -b <branch> origin/main`).

## Naming (files, tests, migrations, vocabulary)

- Files and directories: descriptive, consistent with their neighbours;
  prefer lowercase kebab-case for new files. Framework-standard names
  (`README.md`, `package.json`) stay standard.
- Never name anything `new`, `final`, `old`, `copy`, `misc`, `stuff`,
  `test2`, or with a session ID.
- Tests describe behaviour: `rate-board-seam.spec.ts`, not `test2.spec.ts`.
- Migration filenames describe the schema change; migrations are **never
  renamed or edited after merge** — add the next one instead.
- Public routes and database vocabulary are not casually renamed. Domain
  terminology follows the server's canonical model (see the glossary in
  `docs/REPOSITORY_MAP.md`): `tenant` is the infrastructure word for what the
  product calls a `desk`; `workspace`/`till`/`drawer` are three different
  things; `desk_clients` (KYC file) and `ledger_customers` (counterparty) are
  deliberately distinct.
- Existing runtime-sensitive odd names (for example `CurrencyDesk OS.html`)
  stay until a dedicated, coordinated rename job. Clean architecture matters
  more than aesthetically perfect filenames.

## Pull requests

Use the PR template. Every PR states:

- **Problem** — what is wrong or missing, in product terms.
- **Scope** — the one job this PR does.
- **What changed** / **What deliberately did not change.**
- **Tests run** — which suites, against what database.
- **Documentation updated** — or the explicit "reviewed — no change required"
  checkbox. CI verifies one or the other (`scripts/check-repository-governance.mjs`).
- **Operational risk** and **rollback path** when relevant.

## After merge

Delete the feature branch. Git history and the merged PR are the archive;
the branch list is the live to-do list and should read like one.
