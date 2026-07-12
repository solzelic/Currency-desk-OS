import type { Customer, DeskState, DomainScope, StaffUser, Workspace } from "./types";

export const defaultScope: DomainScope = {
  tenantId: "tenant-yorkfx-demo",
  legalEntityId: "le-yorkfx-canada-demo",
  branchId: "branch-yorkville",
  workspaceId: "workspace-yorkville-till-01"
};

export const staff: StaffUser[] = [
  { ...defaultScope, id: "j.masri", name: "J. Masri", role: "administrator", authorizedBranchIds: [defaultScope.branchId] },
  { ...defaultScope, id: "r.haddad", name: "R. Haddad", role: "branch_manager", authorizedBranchIds: [defaultScope.branchId] },
  { ...defaultScope, id: "a.singh", name: "A. Singh", role: "teller", authorizedBranchIds: [defaultScope.branchId] }
];

export const workspace: Workspace = {
  ...defaultScope,
  branchName: "Yorkville Desk",
  tillId: "till-01",
  businessDate: "2026-07-11"
};

export const customers: Customer[] = [
  { ...defaultScope, id: "c-jakob-miller", name: "Jakob Miller", risk: "Normal", idStatus: "verified", phone: "(416) 555-0182" },
  { ...defaultScope, id: "c-rachel-carter", name: "Rachel Carter", risk: "Medium", idStatus: "on-file", phone: "(416) 555-0138" },
  { ...defaultScope, id: "c-maple-logistics", name: "Maple Leaf Logistics Inc.", risk: "High", idStatus: "verified", phone: "(905) 555-0107" }
];

export function createInitialState(scope: DomainScope = defaultScope): DeskState {
  return {
    scope,
    staff: staff.map((user) => ({ ...user, ...scope, authorizedBranchIds: [scope.branchId] })),
    activeUserId: null,
    workspace: { ...workspace, ...scope },
    customers: customers.map((customer) => ({ ...customer, ...scope })),
    ledger: [],
    receipts: [],
    till: {
      CAD: 25000,
      USD: 12000,
      EUR: 7000,
      GBP: 3500
    }
  };
}
