import type { DeskState, DomainScope } from "../domain/types";
import type { AuditEvent } from "../security/audit";

export interface DeskStatePersistence {
  load(scope: DomainScope): DeskState | null;
  save(state: DeskState): void;
  clear(scope: DomainScope): void;
}

export interface AuditLogPersistence {
  append(event: AuditEvent): void;
  read(scope: DomainScope): readonly Readonly<AuditEvent>[];
}

export interface PersistenceAdapter {
  readonly kind: "memory" | "demo-local-storage" | "backend";
  readonly state: DeskStatePersistence;
  readonly audit: AuditLogPersistence;
}

// A production backend adapter implements this port with authenticated APIs.
// The current synchronous contract is limited to demo and test adapters; a
// remote implementation should sit behind an async application-service layer.
export type BackendPersistenceAdapter = PersistenceAdapter & { readonly kind: "backend" };
