# CurrencyDesk OS

CurrencyDesk OS is an operating system prototype for a currency-exchange and money-services desk. It covers the desk workflow around rates, transactions, customer/KYC files, compliance, till/vault cash, reports, branch operations, transfers, cheques, and a module store.

This repository now has two tracks:

- **Preserved prototype:** the existing buildless React/Babel demo in the repository root and `os-src/`.
- **Frontend foundation:** a new React and TypeScript app under `src/`, built to migrate the product into production-shaped code without disturbing the prototype.

## Current Prototype

Open the prototype through a static server:

```sh
python3 -m http.server 8173
```

Then visit:

- `http://127.0.0.1:8173/CurrencyDesk%20OS.html`
- `http://127.0.0.1:8173/CurrencyDesk%20OS%20(standalone).html`

Testing credentials are intentionally loose in the prototype: use any seeded staff ID, any password, and the prefilled `000000` 2FA code.

## New Frontend App

The TypeScript app coexists with the prototype. Once dependencies are installed:

```sh
npm install
npm run dev
npm run check
```

The first vertical slice is:

Sign in -> open workspace -> select or create customer -> create currency exchange transaction -> run compliance checks -> post transaction -> generate receipt -> update ledger and till.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Migration plan](docs/MIGRATION.md)
- [Repository audit](docs/REPOSITORY_AUDIT.md)
- [KYC developer handoff](design_handoff_kyc/README.md)
- [Session brief](docs/SESSION_BRIEF.md)

## Preservation Policy

The root prototype files are the current demo artifact and should remain runnable throughout the migration. Do not modify `CurrencyDesk OS.html`, `CurrencyDesk OS (standalone).html`, or `os-src/` unless the work explicitly targets the prototype.
