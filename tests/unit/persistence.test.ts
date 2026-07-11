import { describe, expect, it } from "vitest";
import { createInitialState, defaultScope } from "../../src/domain/seed";
import type { DomainScope } from "../../src/domain/types";
import { DemoLocalStoragePersistenceAdapter, type StorageLike } from "../../src/persistence/localStorage";
import { InMemoryPersistenceAdapter } from "../../src/persistence/memory";
import { createAuditEvent } from "../../src/security/audit";

class FakeStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function auditEvent(scope: DomainScope, id: string) {
  return createAuditEvent(
    {
      ...scope,
      actor: { id: "a.singh", role: "teller" },
      action: "session.sign_in",
      target: { type: "session", id: "a.singh" },
      reason: "Test sign-in.",
      correlationId: `correlation-${id}`,
      previousState: null,
      newState: null
    },
    { createId: () => id, now: () => new Date("2026-07-11T12:00:00.000Z") }
  );
}

describe.each([
  ["memory", () => new InMemoryPersistenceAdapter()],
  ["demo localStorage", () => new DemoLocalStoragePersistenceAdapter(new FakeStorage())]
])("%s persistence adapter", (_name, createAdapter) => {
  it("round-trips state without crossing tenant or workspace boundaries", () => {
    const adapter = createAdapter();
    const state = createInitialState();
    const otherScope = { ...defaultScope, tenantId: "tenant-other" };

    adapter.state.save(state);
    expect(adapter.state.load(defaultScope)).toEqual(state);
    expect(adapter.state.load(otherScope)).toBeNull();
  });

  it("keeps audit history append-only and immutable to callers", () => {
    const adapter = createAdapter();
    adapter.audit.append(auditEvent(defaultScope, "audit-1"));
    const log = adapter.audit.read(defaultScope);

    expect(log.map((event) => event.id)).toEqual(["audit-1"]);
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log[0].actor)).toBe(true);
    expect(() => { log[0].actor.id = "changed"; }).toThrow();
    expect(() => adapter.audit.append(auditEvent(defaultScope, "audit-1"))).toThrow("already exists");
    expect("clear" in adapter.audit).toBe(false);
    expect(adapter.audit.read(defaultScope)[0].actor.id).toBe("a.singh");
  });
});
