# CurrencyDesk OS Product Blueprint

## Product intent

CurrencyDesk OS is an operational desktop for a regulated currency exchange house. The approved prototype presents the work as an operating system: staff move between rate, customer, transaction, compliance, ledger, cash, reporting, and administration applications without leaving the desk.

The React foundation currently delivers one connected operating loop:

`sign in -> select or create customer -> quote exchange -> evaluate compliance -> post -> receipt -> ledger -> till`

This is a demo foundation, not a production financial system. Its local browser persistence must never contain real KYC documents, production financial records, credentials, or regulated evidence.

## Product pillars

| Pillar | Product requirement | Current React state |
| --- | --- | --- |
| Desk operating model | Multiple focused apps share one workspace and can be opened together. | Visual shell is implemented for the vertical slice. |
| Transaction integrity | A posted exchange creates a ledger record, receipt, till movement, and audit event. | Implemented. |
| Compliance by default | Block invalid exchanges and surface warnings before posting. | Implemented for the current rules. |
| Security boundaries | Tenant, legal entity, branch, workspace, role, authorization, persistence, and audit boundaries are explicit. | Implemented in the frontend foundation. |
| Operational breadth | Rates, transfers, cheques, vault, branches, filing, reports, pricing, and administration operate as linked applications. | Prototype source of truth; planned for React migration. |

## Current vertical slice

The Exchange Desk is the primary React application. It reads the active workspace, scoped customer records, till position, and active staff member. It writes a new customer, then on a successful post writes a transaction, receipt, till position, persisted workspace state, and append-only audit event.

Posting is an application boundary, not a UI-only rule. It requires the active actor, checks `transaction:post`, confirms tenant/legal-entity/branch/workspace scope, evaluates compliance, then derives the transaction, receipt, ledger update, and till update from pure domain functions.

## Migration principle

The legacy prototype is a preserved visual and interaction reference. It is not the migration target for data logic and must not be edited. React modules should replace individual applications only after their business contracts, permissions, data classifications, audit behavior, and user flows are explicit.

## Prototype parity pass

The current visual-shell pass uses a fixed `1440 x 900` executable prototype capture and the parity matrix in `docs/PROTOTYPE_PARITY_MATRIX.md`. The light menu/tenant/application bars, textured desktop, window dimensions, title chrome, dock state, and dense transaction workspace are being aligned first. The React desktop intentionally opens the secured Exchange Desk rather than the prototype's default Ledger so the already validated sign-in-to-post transaction path remains directly available; this is a recorded partial parity decision, not a new product design.

## Product boundaries

| Area | In scope now | Explicitly not production-ready |
| --- | --- | --- |
| Authentication | Demo staff selection and audit events. | Identity provider, MFA, session expiry, device assurance. |
| Persistence | Typed in-memory adapter for tests and localStorage adapter for demo. | Server persistence, transactions, backups, recovery, key management. |
| Compliance | Deterministic demo checks and warnings. | Jurisdiction-specific policy, sanctions screening, case management, filing. |
| Customer data | Lightweight customer record fields. | Real KYC evidence, document capture/storage, data-subject workflows. |
| Financial records | Demo exchange posting, receipt, ledger, till. | General ledger integration, reconciliation, regulatory record controls. |

## Delivery sequence

1. Preserve the prototype and document its application map.
2. Establish the OS visual shell around the validated transaction slice.
3. Migrate prototype applications one at a time behind the existing security and persistence boundaries.
4. Replace demo persistence with a backend adapter before any real operational use.
