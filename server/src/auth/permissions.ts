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
  | "accounting:cost_method"
  /* Opening a new location, and equipping one with another till.
     A location is what the desk is billed by and what its people, vault and
     books hang off, so opening one is an owner's decision — it stops at the
     administrator, not at whoever runs a counter. Adding a till inside a
     branch is the smaller act: it changes what a manager's own shop can do
     that morning and costs nothing, so a branch manager may do it, for the
     branches they are authorized on. */
  | "desk:locations"
  | "desk:tills"
  /* Signing a report in the desk's name and sending it to the regulator.
     Not a question about the book, which is why it is its own permission
     rather than a shade of `ledger:view`: an auditor may read every report
     the desk has ever filed and may never file one, and that has nothing to
     do with whether they can move money. Everybody who works the counter or
     the compliance queue may file — the person who took the cash is very
     often the person who has to report it before they go home. */
  | "compliance:file";

export const backendRolePermissions: Readonly<Record<string, readonly BackendPermission[]>> = {
  teller: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "customer:view", "customer:write", "ledger:view", "till:count", "vault:view", "compliance:file"],
  supervisor: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "compliance:file"],
  compliance_officer: ["quote:view", "customer:view", "customer:write", "ledger:view", "vault:view", "compliance:file"],
  branch_manager: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method", "desk:tills", "compliance:file"],
  administrator: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method", "desk:locations", "desk:tills", "compliance:file"],
  auditor: ["quote:view", "customer:view", "ledger:view", "vault:view"],
};

export function hasBackendPermission(role: string, permission: BackendPermission) {
  return backendRolePermissions[role]?.includes(permission) ?? false;
}
