# CurrencyDesk OS Architecture

CurrencyDesk OS currently contains two intentionally separate surfaces:

1. The preserved prototype in the repository root.
2. The new React and TypeScript frontend foundation under `src/`.

The prototype remains the design and product reference. The TypeScript app is the migration path toward production engineering.

## Preserved Prototype

The original app is a buildless browser prototype:

- `CurrencyDesk OS.html` is the development entry point.
- `os-src/*.jsx` files load in explicit order and extend `window.CDOS`.
- `cdos-base.jsx` defines tokens, seed data, helpers, rates, and shared primitives.
- `cdos-os.jsx` owns the shell, sign-in, window manager, app mounting, and localStorage state.
- Domain files add modules for ledger, KYC, compliance, till, vault, reports, pricing, transfers, cheques, branches, search, settings, and import.
- Persistence is browser `localStorage` using keys prefixed with `cdos_` plus YorkFX rate-board keys.

Do not refactor the prototype while building the TypeScript foundation. Treat it as a golden reference for behavior, product language, visual hierarchy, and workflow shape.

## Frontend Foundation

The new app is a Vite React TypeScript app. It should grow as a production-shaped implementation while remaining colocated with the prototype.

Initial boundaries:

- `src/domain/` contains pure domain types, seed data, calculations, compliance checks, and transaction posting.
- `src/state/` owns React state orchestration and depends on persistence ports.
- `src/persistence/` defines state/audit ports plus in-memory and demo-only localStorage adapters.
- `src/security/` defines scoped authorization, tenant isolation, audit, classification, retention, and legal-hold primitives.
- `src/components/` contains reusable UI primitives and workflow components.
- `src/App.tsx` composes the vertical slice.
- `src/styles.css` contains foundation styling and design tokens.

The foundation is intentionally local-first for now. Backend services, real auth, KYC providers, rate feeds, tamper-resistant audit storage, and compliance filing integrations are future production boundaries. See `SECURITY_COMPLIANCE_FOUNDATION.md` and `THREAT_MODEL.md`.

The localStorage adapter is for synthetic demonstrations only. It must never hold real KYC documents or production financial data.

## Target Vertical Slice

The first production-shaped slice is:

Sign in -> open workspace -> select or create customer -> create currency exchange transaction -> run compliance checks -> post transaction -> generate receipt -> update ledger and till.

This slice establishes the core domain loop before broader OS modules are migrated.

## Migration Rules

- Preserve the prototype exactly unless a future task explicitly targets it.
- Prefer pure TypeScript domain functions before UI wiring.
- Keep generated state inspectable and easy to reset.
- Add tests around domain behavior before extracting more modules.
- Do not couple the new app to `window.CDOS`; use explicit imports.
- Keep visual language close to the prototype without copying global implementation patterns.
