# Frontend Foundation Threat Model

## Scope

This threat model covers the React frontend foundation, its demo persistence adapters, domain authorization helpers, and audit-event creation. It does not cover the preserved legacy prototype as a production system. Review this model whenever authentication, backend APIs, document handling, third-party screening, exports, or deployment architecture change.

## Assets

- Customer identity and contact information
- KYC and screening evidence references
- Exchange quotes, transactions, receipts, ledger, and till positions
- Roles, permissions, branch assignments, and sessions
- Audit events, correlation identifiers, and retention/legal-hold metadata
- Rates, configuration, credentials, signing keys, and service secrets

## Actors and Trust Boundaries

- Authorized tellers, supervisors, compliance officers, managers, administrators, and auditors
- Malicious or compromised staff accounts
- External attackers controlling a browser, device, network path, dependency, or injected script
- Support, engineering, and vendor personnel with elevated system access
- Browser boundary: all client code and localStorage are untrusted
- API boundary: future services must authenticate and authorize every request
- Tenant boundary: no identifier supplied by the client is sufficient proof of tenant access
- Data-store boundary: database, cache, queue, object store, backup, and audit systems need consistent scoping

## Threats and Required Controls

| Threat | Example | Foundation response | Production requirements |
| --- | --- | --- | --- |
| Spoofing | Selecting or stealing another staff identity | Typed actor and role model | Federated identity, MFA, secure sessions, device/risk controls |
| Tampering | Editing localStorage ledger or audit events | Demo warning; append-only adapter API | Server authority, signatures/hashes where justified, immutable audit storage, reconciliation |
| Repudiation | Denying a warning override or reversal | Actor/action/target/reason/correlation event model | Trusted identity, timestamps, durable ingestion, monitored review |
| Information disclosure | Cross-tenant customer lookup or KYC leakage | Scope on records, tenant/branch authorization checks | Query-level server enforcement, object-store grants, encryption, DLP, penetration testing |
| Denial of service | Flooding posting or export endpoints | Not implemented | Rate limits, quotas, queue controls, backpressure, service objectives, recovery plans |
| Elevation of privilege | Teller changes rates or exports records | Permission matrix and helper functions | Server policy enforcement, admin approvals, access reviews, segregation of duties |
| Injection / XSS | Malicious customer text executes script | React escaping for rendered text | CSP, dependency controls, output encoding, safe file rendering, security testing |
| Replay / duplicate post | Reusing a transaction request | Correlation IDs only | Idempotency keys, nonce/session binding, atomic server transactions |
| Audit suppression | Business write succeeds while audit append fails | Best-effort demo rollback | Transactional audit/outbox, health checks, fail-closed policy where appropriate |
| Data remanence | Deleted data remains in backups or exports | Retention/legal-hold types; no deletion | Approved schedules, disposal workflow, backup expiry, processor attestations |

## Abuse Cases

1. A staff member changes tenant or customer identifiers in browser tools to read another tenant's record.
2. An attacker edits localStorage to fabricate a posted transaction or remove an audit event.
3. A compromised supervisor account performs repeated warning overrides without a documented reason.
4. An export function exposes restricted customer data to an unmanaged device.
5. A malicious upload targets KYC document parsing or staff preview tools.
6. A developer accidentally ships a service credential in a frontend environment variable.
7. A deletion request removes records still subject to statutory retention or legal hold.

## Security Invariants

- Tenant and legal-entity scope are verified before permission checks.
- Branch access is explicit; role alone does not grant branch access.
- Sensitive actions are denied unless the actor has a named permission.
- Audit history has no update or delete operation in the application port.
- Audit events reference prior/new record versions without copying restricted payloads.
- Demo reset does not erase audit history.
- Real KYC documents and production financial records never enter localStorage.
- Production services treat all browser-provided identity, role, scope, amount, rate, and compliance status as untrusted input.

## Review Triggers

Reassess threats before adding real authentication, multi-branch navigation, backend persistence, KYC uploads, screening providers, regulatory reporting, exports, reversals, rate administration, mobile/offline operation, or production deployment.
