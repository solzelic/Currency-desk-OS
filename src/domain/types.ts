export type CurrencyCode = "CAD" | "USD" | "EUR" | "GBP";

export type TenantId = string;
export type LegalEntityId = string;
export type BranchId = string;
export type WorkspaceId = string;

export interface DomainScope {
  tenantId: TenantId;
  legalEntityId: LegalEntityId;
  branchId: BranchId;
  workspaceId: WorkspaceId;
}

export type StaffRole =
  | "teller"
  | "supervisor"
  | "compliance_officer"
  | "branch_manager"
  | "administrator"
  | "auditor";

export interface StaffUser extends DomainScope {
  id: string;
  name: string;
  role: StaffRole;
  authorizedBranchIds: BranchId[];
}

export interface Workspace extends DomainScope {
  branchName: string;
  tillId: string;
  businessDate: string;
}

export interface Customer extends DomainScope {
  id: string;
  name: string;
  risk: "Low" | "Normal" | "Medium" | "High";
  idStatus: "missing" | "on-file" | "verified" | "expired";
  phone?: string;
}

export interface RateQuote {
  from: CurrencyCode;
  to: CurrencyCode;
  inputAmount: number;
  rate: number;
  outputAmount: number;
  feeCad: number;
  spreadCad: number;
  totalProfitCad: number;
}

export interface ComplianceCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "block";
  detail: string;
}

export interface ExchangeDraft {
  customerId: string;
  from: CurrencyCode;
  to: CurrencyCode;
  inputAmount: number;
  feeCad: number;
  purpose: string;
  sourceOfFunds: string;
}

export interface LedgerTransaction extends DomainScope {
  id: string;
  ref: string;
  postedAt: string;
  tellerId: string;
  customerId: string;
  from: CurrencyCode;
  to: CurrencyCode;
  inputAmount: number;
  outputAmount: number;
  rate: number;
  feeCad: number;
  spreadCad: number;
  profitCad: number;
  compliance: ComplianceCheck[];
  purpose: string;
  sourceOfFunds: string;
}

export interface Receipt extends DomainScope {
  id: string;
  transactionId: string;
  issuedAt: string;
  lines: string[];
}

export interface TillPosition {
  [currency: string]: number;
}

export interface DeskState {
  scope: DomainScope;
  staff: StaffUser[];
  activeUserId: string | null;
  workspace: Workspace;
  customers: Customer[];
  ledger: LedgerTransaction[];
  receipts: Receipt[];
  till: TillPosition;
}
