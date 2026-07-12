export type LedgerRole = "teller" | "supervisor" | "compliance_officer" | "branch_manager" | "administrator" | "auditor";
export type LedgerCurrency = "CAD" | "USD" | "EUR" | "GBP";

export interface LedgerScope {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  workspaceId: string;
  tillId: string;
}

export interface AuthenticatedLedgerActor extends LedgerScope {
  userId: string;
  role: LedgerRole;
  authorizedBranchIds: readonly string[];
}

export interface PostExchangeRequest {
  idempotencyKey: string;
  customerId: string;
  from: LedgerCurrency;
  to: LedgerCurrency;
  inputAmount: string;
  feeCad: string;
  purpose: string;
  sourceOfFunds: string;
}

export interface ReverseTransactionRequest {
  idempotencyKey: string;
  reason: string;
}

export interface ReceiptReadyTransaction {
  transactionId: string;
  transactionRef: string;
  postedAt: string;
  status: "posted" | "reversed";
  customerId: string;
  from: LedgerCurrency;
  to: LedgerCurrency;
  inputAmount: string;
  outputAmount: string;
  rate: string;
  feeCad: string;
  spreadCad: string;
  receipt: { receiptId: string; lines: string[] };
}

export type LedgerFailureCode =
  | "AUTHENTICATION_REQUIRED"
  | "SCOPE_DENIED"
  | "AUTHORIZATION_DENIED"
  | "CUSTOMER_NOT_FOUND"
  | "INVALID_REQUEST"
  | "COMPLIANCE_BLOCKED"
  | "INSUFFICIENT_TILL_LIQUIDITY"
  | "RATE_NOT_AVAILABLE"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "TRANSACTION_NOT_FOUND"
  | "REVERSAL_ALREADY_EXISTS"
  | "REVERSAL_NOT_ALLOWED";
