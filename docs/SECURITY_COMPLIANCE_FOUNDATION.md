# Security and Compliance Foundation

## Status and Non-Compliance Notice

This repository does **not** claim SOC 2, GDPR, AML, FINTRAC, or any other
regulatory certification or compliance status. This document maps what the
engineering provides against what those frameworks require; legal counsel,
compliance owners, security owners, auditors, and accountable management
must confirm policy, regulatory applicability, evidence, and operating
effectiveness.

(An earlier version of this document scoped itself to a since-deleted
frontend foundation and its localStorage persistence adapters. That
architecture is gone; the sections below that name it are corrected here.)

## Architecture Boundary — as shipped

Authority is server-side: authentication is per-employee scrypt credentials
with opaque revocable sessions; authorization is checked on the server;
every query is tenant-scoped; the financial ledger is append-only Postgres
with idempotency keys and a server-minted identity for every record
(`docs/CASH_OWNERSHIP_INVARIANTS.md`); client/KYC records and ID documents
are server tables with audited reveals (`docs/CLIENT_RECORDS.md`);
`ledger_audit_events` is the append-only audit trail. The browser holds a
versioned JSON document of desk preferences and screen state
(`server/src/state/shape.ts` catalogues every key and marks which are
records vs preferences) — not the book, not credentials, not KYC documents.

Audit events contain state references, not full before/after payloads. This
limits unnecessary sensitive-data duplication while retaining correlation
to versioned records in the system of record.

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

(Re-verified 2026-08-15. The gaps the earlier version listed —
demo-selector authentication, client-side authorization, browser-editable
audit events — closed when authority moved server-side; see the
Architecture Boundary above.)

- No second factor on the platform operator console (issue #33).
- `PLATFORM_ADMIN_BOOTSTRAP` re-asserts the configured operator password on
  every boot while set (issue #31).
- Compliance thresholds resolve through jurisdiction packs with desk
  overrides (`docs/DESK_THRESHOLDS.md`), but workflow behavior beyond
  thresholds remains a product assumption, not a certified process.
- Retention rules are written down (`docs/CLIENT_RECORDS.md`), but no
  disposition engine enforces them yet.
- Monitoring, alerting, backup and disaster-recovery are the hosting
  platform's defaults, not designed controls.
- ID scans and cheque images live in Postgres rows rather than object
  storage (`docs/ROAD_TO_DEPLOYMENT.md`).
