import type { DomainScope, StaffRole } from "../domain/types";

export type AuditAction =
  | "session.sign_in"
  | "session.sign_out"
  | "customer.create"
  | "transaction.post"
  | "transaction.post_failed"
  | "demo.reset";

export interface AuditActor {
  id: string;
  role: StaffRole | "anonymous" | "system";
}

export interface AuditTarget {
  type: "session" | "customer" | "transaction" | "workspace";
  id: string;
}

export interface AuditStateReference {
  type: AuditTarget["type"];
  id: string;
  version: string;
}

export interface AuditEvent extends DomainScope {
  id: string;
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  timestamp: string;
  reason: string | null;
  correlationId: string;
  previousState: AuditStateReference | null;
  newState: AuditStateReference | null;
}

export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp">;

export interface AuditEventFactoryOptions {
  now?: () => Date;
  createId?: () => string;
}

function defaultId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createAuditEvent(
  input: AuditEventInput,
  options: AuditEventFactoryOptions = {}
): Readonly<AuditEvent> {
  const event: AuditEvent = {
    ...input,
    id: options.createId?.() ?? defaultId(),
    timestamp: (options.now?.() ?? new Date()).toISOString()
  };

  return Object.freeze(event);
}

export function auditStateReference(target: AuditTarget, version: string): AuditStateReference {
  return { ...target, version };
}
