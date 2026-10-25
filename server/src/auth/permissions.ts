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
     rather than a shade of `ledger:view`. An auditor does not file.
     A teller does not file. Supervisor and the compliance roles do.
     `filing:view` is who may open the filing record. Which report
     they may see is shared/str-role.js. */
  | "compliance:file"
  | "filing:view"
  /* Moving the line the desk reports and identifies at.
     Rarer than filing, and a different act entirely: filing discharges an
     obligation the rules created, this decides which deals create one at
     all. Tightening past the pack is an ordinary business decision; going
     looser is the desk failing to report things it is legally obliged to
     report. Nothing stops the second — the relationship is a posture, not
     a constraint, for the reasons in thresholds.ts.

     So this is the OWNER's, and nobody else's. Narrower than
     `compliance:file`, which a teller does not hold, and
     narrower than `accounting:cost_method`, which a branch manager shares.
     Where the reporting line sits is not a day's work at a branch — it is
     the standing policy of the registered business, and the registered
     business is one person. A compliance officer or a manager who wants it
     moved asks the owner, which is a conversation worth having out loud. */
  | "compliance:thresholds"
  /* Shop earnings, P&L, cost of sale, the booked spread, unrealized
     P&L, cost basis, market value, the market mid, and the per-teller
     money split. Closing the day (`till:close`) is what opens these
     reads today. This permission is the other door, for someone who
     reads the book's take without closing the drawer. No role holds
     it. Granting it is a separate decision. The customer-facing fee
     is not one of these. A teller, an auditor, and a compliance
     officer have neither. */
  | "report:earnings";

export const backendRolePermissions: Readonly<Record<string, readonly BackendPermission[]>> = {
  teller: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "customer:view", "customer:write", "ledger:view", "till:count", "vault:view"],
  supervisor: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "compliance:file", "filing:view"],
  compliance_officer: ["quote:view", "customer:view", "customer:write", "ledger:view", "vault:view", "compliance:file", "filing:view"],
  branch_manager: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method", "desk:tills", "compliance:file", "filing:view"],
  administrator: ["quote:create", "quote:view", "quote:cancel", "quote:post", "transaction:post", "transaction:reverse", "customer:view", "customer:write", "ledger:view", "till:initialize", "till:count", "till:close", "till:move", "vault:view", "vault:initialize", "vault:move", "rates:change", "rates:override", "accounting:cost_method", "desk:locations", "desk:tills", "compliance:file", "filing:view", "compliance:thresholds"],
  auditor: ["quote:view", "customer:view", "ledger:view", "vault:view"],
};

/** Close-day is `till:close`. The earnings report is `report:earnings`. */
export function canReadDeskEarnings(role: string) {
  return hasBackendPermission(role, "till:close") || hasBackendPermission(role, "report:earnings");
}

export function hasBackendPermission(role: string, permission: BackendPermission) {
  return backendRolePermissions[role]?.includes(permission) ?? false;
}
