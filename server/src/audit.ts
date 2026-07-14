/* ============================================================
   Append-only audit writer — one call per security-relevant event.
   Shared by auth and staff-admin routes so every credential action
   (login, logout, create, reset, deactivate) lands in audit_events
   with the same shape. Detail never contains secrets.
   ============================================================ */
import { randomUUID } from "node:crypto";
import { schema } from "./db/index.js";
import type { Db } from "./db/index.js";

export interface AuditEntry {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  actorId?: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

export async function audit(db: Db, e: AuditEntry): Promise<void> {
  await db.insert(schema.auditEvents).values({
    id: randomUUID(),
    tenantId: e.tenantId,
    legalEntityId: e.legalEntityId,
    branchId: e.branchId,
    actorId: e.actorId ?? null,
    action: e.action,
    detail: e.detail ?? {},
  });
}
