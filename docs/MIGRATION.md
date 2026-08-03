# Frontend Migration Plan

> **Obsolete, 2026-08-03 — kept for the record only.** This is the plan to
> migrate the prototype into a Vite/React app under `src/`. That migration was
> abandoned and the app deleted: its CI was green while the shipped code went
> unwatched, which is how a dead Settings screen survived for days. The
> "preserved prototype" became the product.
>
> Nothing here is a current instruction. Phase 3's list is the one part that
> outlived it, and it is now tracked properly in `docs/SAAS_ROADMAP.md` and
> `docs/NEXT-PUSH.md`. For how to work on the code today, see
> `docs/DEVELOPMENT.md`.


## Phase 0: Repository Foundation

- Document the preserved prototype and repository structure.
- Add `.gitignore` rules for Node, build output, local environment files, and editor state.
- Add a Vite React TypeScript app that runs beside the prototype.

## Phase 1: Core Desk Slice

Build the first vertical slice in TypeScript:

1. Staff sign-in with seeded users.
2. Workspace state for branch, till, ledger, customers, receipts, and cash position.
3. Customer search and customer creation.
4. Currency exchange transaction drafting.
5. Compliance checks for ID policy, reportable threshold, and basic risk notes.
6. Transaction posting into ledger.
7. Receipt generation from posted transaction.
8. Till position update from posted transaction.

## Phase 2: Prototype Parity Modules

Migrate one module at a time:

- Ledger detail and corrections.
- KYC verification workflow.
- Compliance filing worksheets.
- Till reconciliation and shift handoff.
- Vault and branch movement.
- Pricing and rate-board administration.
- Reports and audit history.

## Phase 3: Production Readiness

Replace demo infrastructure:

- localStorage persistence -> backend API and database.
- Mock sign-in -> identity provider and sessions.
- Simulated KYC -> provider integration.
- Static rates -> provider-backed rate feed with lock/audit history.
- Browser-only receipts -> durable receipt and document storage.
- Prototype compliance rules -> jurisdiction-validated rules engine.

## Compatibility Policy

The root prototype files remain runnable throughout migration. The Vite app is additive and should not require changes to `CurrencyDesk OS.html` or `os-src/`.
