import type { Customer, DeskState, StaffUser, Workspace } from "./types";

export const staff: StaffUser[] = [
  { id: "j.masri", name: "J. Masri", role: "Owner" },
  { id: "r.haddad", name: "R. Haddad", role: "Manager" },
  { id: "a.singh", name: "A. Singh", role: "Teller" }
];

export const workspace: Workspace = {
  branchId: "yorkville",
  branchName: "Yorkville Desk",
  tillId: "till-01",
  businessDate: "2026-07-11"
};

export const customers: Customer[] = [
  { id: "c-jakob-miller", name: "Jakob Miller", risk: "Normal", idStatus: "verified", phone: "(416) 555-0182" },
  { id: "c-rachel-carter", name: "Rachel Carter", risk: "Medium", idStatus: "on-file", phone: "(416) 555-0138" },
  { id: "c-maple-logistics", name: "Maple Leaf Logistics Inc.", risk: "High", idStatus: "verified", phone: "(905) 555-0107" }
];

export function createInitialState(): DeskState {
  return {
    staff,
    activeUserId: null,
    workspace,
    customers,
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
