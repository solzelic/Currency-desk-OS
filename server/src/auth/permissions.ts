export type BackendPermission =
  | "transaction:post"
  | "transaction:reverse"
  | "quote:create"
  | "quote:view"
  | "quote:cancel"
  | "quote:post"
  | "rates:change"
  | "rates:override";

export const backendRolePermissions: Readonly<Record<string, readonly BackendPermission[]>> = {
  teller: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post"],
  supervisor: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse"],
  compliance_officer: ["quote:view"],
  branch_manager: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "rates:change", "rates:override"],
  administrator: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "rates:change", "rates:override"],
  auditor: ["quote:view"],
};

export function hasBackendPermission(role: string, permission: BackendPermission) {
  return backendRolePermissions[role]?.includes(permission) ?? false;
}
