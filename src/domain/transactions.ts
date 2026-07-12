import type { ComplianceCheck, Customer, ExchangeDraft, LedgerTransaction, Receipt, StaffUser, Workspace } from "./types";
import { canPost } from "./compliance";
import { inputAmountCad, money, quoteExchange, round } from "./rates";
import { assertSameWorkspace } from "../security/tenantIsolation";

export function postExchangeTransaction(params: {
  draft: ExchangeDraft;
  customer: Customer;
  teller: StaffUser;
  workspace: Workspace;
  compliance: ComplianceCheck[];
  sequence: number;
  now?: Date;
}): LedgerTransaction {
  if (!canPost(params.compliance)) {
    throw new Error("Cannot post a transaction with blocking checks.");
  }
  assertSameWorkspace(params.workspace, params.customer);
  assertSameWorkspace(params.workspace, params.teller);

  const now = params.now ?? new Date();
  const quote = quoteExchange(params.draft.from, params.draft.to, params.draft.inputAmount, params.draft.feeCad);

  return {
    tenantId: params.workspace.tenantId,
    legalEntityId: params.workspace.legalEntityId,
    branchId: params.workspace.branchId,
    workspaceId: params.workspace.workspaceId,
    id: `tx-${now.getTime()}-${params.sequence}`,
    ref: `CD-${now.toISOString().slice(2, 10).replace(/-/g, "")}-${String(params.sequence).padStart(3, "0")}`,
    postedAt: now.toISOString(),
    tellerId: params.teller.id,
    customerId: params.customer.id,
    from: params.draft.from,
    to: params.draft.to,
    inputAmount: params.draft.inputAmount,
    outputAmount: quote.outputAmount,
    rate: quote.rate,
    feeCad: params.draft.feeCad,
    spreadCad: quote.spreadCad,
    profitCad: quote.totalProfitCad,
    compliance: params.compliance,
    purpose: params.draft.purpose,
    sourceOfFunds: params.draft.sourceOfFunds
  };
}

export function createReceipt(transaction: LedgerTransaction, customer: Customer, teller: StaffUser): Receipt {
  assertSameWorkspace(transaction, customer);
  assertSameWorkspace(transaction, teller);

  return {
    tenantId: transaction.tenantId,
    legalEntityId: transaction.legalEntityId,
    branchId: transaction.branchId,
    workspaceId: transaction.workspaceId,
    id: `rcpt-${transaction.id}`,
    transactionId: transaction.id,
    issuedAt: transaction.postedAt,
    lines: [
      "CurrencyDesk OS",
      `Receipt ${transaction.ref}`,
      `Customer: ${customer.name}`,
      `Teller: ${teller.name}`,
      `Paid: ${money(transaction.inputAmount, transaction.from)}`,
      `Received: ${money(transaction.outputAmount, transaction.to)}`,
      `Rate: 1 ${transaction.from} = ${transaction.rate.toFixed(4)} ${transaction.to}`,
      `Fee: ${money(transaction.feeCad)}`,
      `CAD equivalent: ${money(inputAmountCad(transaction.from, transaction.inputAmount))}`
    ]
  };
}

export function applyTransactionToTill(
  till: Record<string, number>,
  transaction: LedgerTransaction
): Record<string, number> {
  return {
    ...till,
    [transaction.from]: round((till[transaction.from] || 0) + transaction.inputAmount, 2),
    [transaction.to]: round((till[transaction.to] || 0) - transaction.outputAmount, 2)
  };
}
