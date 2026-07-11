import { describe, expect, it } from "vitest";
import { defaultScope } from "../../src/domain/seed";
import { auditStateReference, createAuditEvent } from "../../src/security/audit";

describe("audit event creation", () => {
  it("creates a complete, timestamped event without embedding record state", () => {
    const target = { type: "transaction" as const, id: "tx-1" };
    const event = createAuditEvent(
      {
        ...defaultScope,
        actor: { id: "a.singh", role: "teller" },
        action: "transaction.post",
        target,
        reason: "Authorized post.",
        correlationId: "correlation-1",
        previousState: null,
        newState: auditStateReference(target, "2026-07-11T12:00:00.000Z")
      },
      {
        now: () => new Date("2026-07-11T12:00:00.000Z"),
        createId: () => "audit-1"
      }
    );

    expect(event).toMatchObject({
      id: "audit-1",
      tenantId: defaultScope.tenantId,
      branchId: defaultScope.branchId,
      action: "transaction.post",
      timestamp: "2026-07-11T12:00:00.000Z",
      correlationId: "correlation-1"
    });
    expect(event.newState).toEqual({ type: "transaction", id: "tx-1", version: "2026-07-11T12:00:00.000Z" });
    expect(Object.isFrozen(event)).toBe(true);
  });
});
