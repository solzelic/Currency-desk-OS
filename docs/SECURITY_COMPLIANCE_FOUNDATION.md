# Security and Compliance Foundation

## Status and Non-Compliance Notice

This repository is an engineering prototype. It is **not production compliant** and does not claim SOC 2, GDPR, AML, FINTRAC, or any other regulatory certification or compliance status.

The `DemoLocalStoragePersistenceAdapter` exists only to support local demonstrations. Browser `localStorage` is not an approved store for production financial records, personal data, authentication material, screening evidence, or audit records. **Never place real KYC documents or production financial data in this application or its localStorage adapter.**

The code establishes vocabulary and boundaries that can support later controls. Legal counsel, compliance owners, security owners, auditors, and accountable management must confirm policy, regulatory applicability, evidence, and operating effectiveness.

## Architecture Boundary

The frontend depends on the typed `PersistenceAdapter` port:

- `InMemoryPersistenceAdapter` provides isolated deterministic test storage.
- `DemoLocalStoragePersistenceAdapter` provides untrusted, demo-only browser persistence.
- `BackendPersistenceAdapter` marks the future production boundary.

A production adapter must use authenticated server APIs and an asynchronous application-service layer. It must not expose database credentials to the browser. State changes and audit appends need transactional guarantees or a durable outbox; the demo adapter cannot provide these guarantees.

Audit events contain state references, not full before/after payloads. This limits unnecessary sensitive-data duplication while retaining correlation to versioned records in a future system of record.

## SOC 2 Readiness Mapping

This is a design mapping, not a SOC 2 assertion or control test.

| Trust-services area | Current technical foundation | Required confirmation and production work |
| --- | --- | --- |
| Security / logical access | Roles, permissions, tenant and branch checks | Identity provider, MFA, lifecycle approvals, periodic access reviews, server enforcement, evidence |
| Security / monitoring | Structured audit event model and correlation IDs | Tamper-resistant central ingestion, alert rules, time synchronization, review procedures, retention |
| Change management | Typed boundaries and automated tests | Protected branches, reviewer requirements, deployment approvals, segregation of duties, change evidence |
| Processing integrity | Pure quotation/posting functions and scoped records | Server-side validation, idempotency, reconciliation, exception handling, external rate integrity |
| Confidentiality | Data-classification catalog and access permissions | Encryption, key management, DLP, vendor controls, approved handling procedures |
| Availability | No material control implemented | Service objectives, backups, restoration tests, capacity planning, disaster recovery, incident exercises |
| Privacy | Classification, retention, and legal-hold types | Data inventory, lawful-basis records, notices, request workflow, processor agreements, jurisdiction analysis |

## GDPR Principles and Rights

Applicability and lawful basis require legal confirmation. The architecture should support:

- **Lawfulness, fairness, and transparency:** record purpose and legal basis outside the transaction payload; provide approved notices.
- **Purpose limitation:** authorize use by action and workspace; do not repurpose KYC or transaction data without review.
- **Data minimization:** audit references instead of copied customer payloads; keep KYC documents outside browser storage.
- **Accuracy:** future correction workflows must preserve history and audit who changed a record.
- **Storage limitation:** assign approved retention policies and calculate disposition eligibility server-side.
- **Integrity and confidentiality:** enforce tenant isolation, least privilege, encryption, secrets management, and monitored access.
- **Accountability:** retain policy versions, approvals, evidence, audit events, and control-operation records.

Potential data-subject rights include access, rectification, erasure, restriction, portability, objection, and protections related to automated decisions. A production request workflow must authenticate the requester, search all systems and processors, record decisions and deadlines, produce reviewed exports, and preserve an audit trail.

## Financial-Record Retention Conflicts

Erasure or minimization requests can conflict with statutory financial-record, AML, sanctions, tax, litigation, or regulatory-examination duties. The retention and legal-hold types intentionally do not implement destructive deletion.

Before deletion exists, policy owners and counsel must define, by jurisdiction and record class:

- the authoritative retention trigger and minimum/maximum period;
- legal basis for continued retention or restricted processing;
- precedence when several schedules apply;
- legal-hold creation, review, release, and evidence;
- disposition approval and proof of deletion across primary systems, replicas, backups, and processors;
- the response language used when a data-subject request cannot be fully fulfilled.

## Tenant Isolation

Every scoped record carries `tenantId`, `legalEntityId`, `branchId`, and `workspaceId`. Authorization first verifies tenant/legal-entity alignment and branch assignment. Persistence keys include all four identifiers, and adapters reject mixed-workspace state.

These client checks are defense in depth only. Production isolation must be enforced server-side on every query and mutation, ideally using tenant-aware database constraints or row-level security, scoped service credentials, tenant-qualified cache and object-storage keys, and tests designed to detect insecure direct-object references.

## Encryption Boundaries

- Browser-to-service traffic must use current approved TLS configuration.
- Production records, backups, queues, object storage, and audit stores require encryption at rest under managed keys.
- KYC documents should use a dedicated encrypted object store with short-lived access grants and malware/content validation.
- Key access and rotation must be separated from application deployment rights.
- `localStorage` is not encrypted storage. Device or browser access can expose it.
- Field-level or envelope encryption may be required for restricted data after threat and query-pattern analysis.

## Secrets Management

No production secret may be embedded in frontend source, Vite variables, localStorage, repository files, screenshots, or audit reasons. Browser-delivered values are public regardless of naming.

Production services should retrieve secrets from an approved secret manager using workload identity, use least-privilege and short-lived credentials, rotate them, monitor access, and maintain an emergency revocation procedure. CI should scan commits and build artifacts for accidental credentials.

## Incident Logging

Audit events record accountable business actions. Security telemetry is a separate stream and should include authentication failures, authorization denials, suspicious exports, rate changes, administrative actions, integrity failures, and service errors. Both streams should share correlation IDs and trusted timestamps.

Logs must avoid credentials, full identity documents, payment data, or unnecessary customer payloads. Production logging needs centralized ingestion, access controls, integrity protection, alerting, documented triage/escalation, evidence preservation, breach-assessment procedures, and tested notification playbooks.

## Current Gaps

- Authentication is a demo account selector, not identity verification.
- Authorization is client-side and therefore bypassable.
- localStorage state and audit events can be read, edited, or removed by the browser user.
- Persistence and audit writes are not crash-atomic.
- There is no production encryption, key management, secrets integration, alerting, backup, or disaster recovery.
- Compliance thresholds and workflow behavior remain prototype assumptions.
- Retention schedules and legal holds are types only; no disposition engine exists.
- No KYC-document storage is implemented, by design.
