export type CurrencyCode = "CAD" | "USD" | "EUR" | "GBP";

export type StaffRole = "Owner" | "Manager" | "Teller";

export interface StaffUser {
  id: string;
  name: string;
  role: StaffRole;
}

export interface Workspace {
  branchId: string;
  branchName: string;
  tillId: string;
  businessDate: string;
}

export interface Customer {
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

export interface LedgerTransaction {
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

export interface Receipt {
  id: string;
  transactionId: string;
  issuedAt: string;
  lines: string[];
}

export interface TillPosition {
  [currency: string]: number;
}

export interface DeskState {
  staff: StaffUser[];
  activeUserId: string | null;
  workspace: Workspace;
  customers: Customer[];
  ledger: LedgerTransaction[];
  receipts: Receipt[];
  till: TillPosition;
}
