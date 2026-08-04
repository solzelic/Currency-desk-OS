export type BackendPermission =
  | "transaction:post"
  | "transaction:reverse"
  | "quote:create"
  | "quote:view"
  | "quote:cancel"
  | "quote:post"
  | "customer:view"
  | "customer:write"
  | "ledger:view"
  | "till:initialize"
  | "till:count"
  | "till:close"
  | "till:move"
  | "vault:view"
  | "vault:initialize"
  | "vault:move"
  | "rates:change"
  | "rates:override"
  /* Changing how inventory is costed — weighted average or FIFO — changes
     what the book reports as profit. Deliberately narrower than the rest
     of the ledger permissions: a teller posting deals and a supervisor
     closing a drawer have no reason to restate the desk's margin, so this
     stops at the people who answer for the accounts. */
  | "accounting:cost_method";

export const backendRolePermissions: Readonly<Record<string, readonly BackendPermission[]>> = {
  teller: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "customer:view", "customer:write", "ledger:view", "till:count", "vault:view"],
  supervisor: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move"],
  compliance_officer: ["quote:view", "customer:view", "customer:write", "ledger:view", "vault:view"],
  branch_manager: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method"],
  administrator: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method"],
  auditor: ["quote:view", "customer:view", "ledger:view", "vault:view"],
};

export function hasBackendPermission(role: string, permission: BackendPermission) {
  return backendRolePermissions[role]?.includes(permission) ?? false;
}
