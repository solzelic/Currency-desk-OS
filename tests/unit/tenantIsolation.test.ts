import { describe, expect, it } from "vitest";
import { createInitialState, defaultScope } from "../../src/domain/seed";
import { assertDeskStateIsolation, assertSameTenant, isSameWorkspace, tenantKey } from "../../src/security/tenantIsolation";

describe("tenant isolation", () => {
  it("uses every scope identifier in persistence boundaries", () => {
    const otherBranch = { ...defaultScope, branchId: "branch-other" };
    expect(tenantKey(otherBranch)).not.toBe(tenantKey(defaultScope));
    expect(isSameWorkspace(defaultScope, otherBranch)).toBe(false);
  });

  it("rejects cross-tenant access and contaminated workspace state", () => {
    expect(() => assertSameTenant(defaultScope, { ...defaultScope, tenantId: "tenant-other" })).toThrow(
      "Tenant boundary violation."
    );

    const state = createInitialState();
    state.customers[0] = { ...state.customers[0], tenantId: "tenant-other" };
    expect(() => assertDeskStateIsolation(state)).toThrow("Workspace boundary violation.");
  });
});
