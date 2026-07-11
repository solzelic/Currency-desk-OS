import { describe, expect, it } from "vitest";
import { defaultScope } from "../../src/domain/seed";
import type { StaffRole, StaffUser } from "../../src/domain/types";
import { authorize, rolePermissions } from "../../src/security/authorization";

function actor(role: StaffRole, overrides: Partial<StaffUser> = {}): StaffUser {
  return {
    ...defaultScope,
    id: `user-${role}`,
    name: role,
    role,
    authorizedBranchIds: [defaultScope.branchId],
    ...overrides
  };
}

describe("authorization rules", () => {
  it("defines permissions for every supported role", () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([
      "administrator",
      "auditor",
      "branch_manager",
      "compliance_officer",
      "supervisor",
      "teller"
    ]);
    expect(authorize(actor("teller"), "transaction:post", defaultScope).allowed).toBe(true);
    expect(authorize(actor("teller"), "rates:change", defaultScope).allowed).toBe(false);
    expect(authorize(actor("supervisor"), "compliance:override_warning", defaultScope).allowed).toBe(true);
    expect(authorize(actor("compliance_officer"), "transaction:post", defaultScope).allowed).toBe(false);
    expect(authorize(actor("branch_manager"), "transaction:reverse", defaultScope).allowed).toBe(true);
    expect(authorize(actor("administrator"), "rates:change", defaultScope).allowed).toBe(true);
    expect(authorize(actor("auditor"), "records:export", defaultScope).allowed).toBe(true);
    expect(authorize(actor("auditor"), "transaction:post", defaultScope).allowed).toBe(false);
  });

  it("denies cross-tenant and unassigned-branch access before checking roles", () => {
    const administrator = actor("administrator");
    expect(authorize(administrator, "records:export", { ...defaultScope, tenantId: "tenant-other" })).toEqual({
      allowed: false,
      reason: "tenant_denied"
    });
    expect(authorize(administrator, "records:export", { ...defaultScope, branchId: "branch-other" })).toEqual({
      allowed: false,
      reason: "branch_denied"
    });
  });
});
