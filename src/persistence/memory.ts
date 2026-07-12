import type { DeskState, DomainScope } from "../domain/types";
import type { AuditEvent } from "../security/audit";
import { assertDeskStateIsolation } from "../security/tenantIsolation";
import { tenantKey } from "../security/tenantIsolation";
import { cloneValue, deepFreeze } from "./immutability";
import type { PersistenceAdapter } from "./types";

export class InMemoryPersistenceAdapter implements PersistenceAdapter {
  readonly kind = "memory" as const;
  private readonly states = new Map<string, DeskState>();
  private readonly auditEvents = new Map<string, readonly Readonly<AuditEvent>[]>();

  readonly state = {
    load: (scope: DomainScope): DeskState | null => {
      const state = this.states.get(tenantKey(scope));
      return state ? cloneValue(state) : null;
    },
    save: (state: DeskState): void => {
      assertDeskStateIsolation(state);
      this.states.set(tenantKey(state.scope), cloneValue(state));
    },
    clear: (scope: DomainScope): void => {
      this.states.delete(tenantKey(scope));
    }
  };

  readonly audit = {
    append: (event: AuditEvent): void => {
      const key = tenantKey(event);
      const current = this.auditEvents.get(key) ?? [];
      if (current.some((item) => item.id === event.id)) {
        throw new Error(`Audit event ${event.id} already exists.`);
      }
      const stored = deepFreeze(cloneValue(event));
      this.auditEvents.set(key, Object.freeze([...current, stored]));
    },
    read: (scope: DomainScope): readonly Readonly<AuditEvent>[] => {
      const current = this.auditEvents.get(tenantKey(scope)) ?? [];
      return deepFreeze(cloneValue(current));
    }
  };
}
