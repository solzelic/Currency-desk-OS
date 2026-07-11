import type { DeskState, DomainScope } from "../domain/types";
import type { AuditEvent } from "../security/audit";
import { assertDeskStateIsolation, assertSameWorkspace, tenantKey } from "../security/tenantIsolation";
import { cloneValue, deepFreeze } from "./immutability";
import type { PersistenceAdapter } from "./types";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class DemoLocalStoragePersistenceAdapter implements PersistenceAdapter {
  readonly kind = "demo-local-storage" as const;

  constructor(
    private readonly storage: StorageLike,
    private readonly prefix = "currencydesk.demo.v2"
  ) {}

  readonly state = {
    load: (scope: DomainScope): DeskState | null => {
      const raw = this.storage.getItem(this.stateKey(scope));
      if (!raw) return null;

      try {
        const state = JSON.parse(raw) as DeskState;
        assertSameWorkspace(scope, state.scope);
        assertDeskStateIsolation(state);
        return cloneValue(state);
      } catch {
        return null;
      }
    },
    save: (state: DeskState): void => {
      assertDeskStateIsolation(state);
      this.storage.setItem(this.stateKey(state.scope), JSON.stringify(state));
    },
    clear: (scope: DomainScope): void => {
      this.storage.removeItem(this.stateKey(scope));
    }
  };

  readonly audit = {
    append: (event: AuditEvent): void => {
      const current = this.readAudit(event);
      if (current.some((item) => item.id === event.id)) {
        throw new Error(`Audit event ${event.id} already exists.`);
      }
      this.storage.setItem(this.auditKey(event), JSON.stringify([...current, event]));
    },
    read: (scope: DomainScope): readonly Readonly<AuditEvent>[] => {
      return deepFreeze(cloneValue(this.readAudit(scope)));
    }
  };

  private stateKey(scope: DomainScope): string {
    return `${this.prefix}:${tenantKey(scope)}:state`;
  }

  private auditKey(scope: DomainScope): string {
    return `${this.prefix}:${tenantKey(scope)}:audit`;
  }

  private readAudit(scope: DomainScope): AuditEvent[] {
    const raw = this.storage.getItem(this.auditKey(scope));
    if (!raw) return [];

    try {
      const events = JSON.parse(raw) as AuditEvent[];
      if (!Array.isArray(events)) return [];
      return events.filter((event) => {
        try {
          assertSameWorkspace(scope, event);
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
}
