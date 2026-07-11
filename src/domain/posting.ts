import { canPost, runComplianceChecks } from "./compliance";
import { applyTransactionToTill, createReceipt, postExchangeTransaction } from "./transactions";
import type { DeskState, ExchangeDraft, LedgerTransaction, Receipt } from "./types";

export type PostExchangeResult =
  | {
      ok: true;
      state: DeskState;
      transaction: LedgerTransaction;
      receipt: Receipt;
    }
  | {
      ok: false;
      reason: string;
    };

export function postExchange(state: DeskState, draft: ExchangeDraft, now?: Date): PostExchangeResult {
  const customer = state.customers.find((item) => item.id === draft.customerId);
  const teller = state.staff.find((item) => item.id === state.activeUserId);

  if (!customer || !teller) {
    return { ok: false, reason: "Missing customer or active user." };
  }

  const compliance = runComplianceChecks(customer, draft, state.till);
  if (!canPost(compliance)) {
    return { ok: false, reason: "Compliance checks are blocking." };
  }

  const transaction = postExchangeTransaction({
    draft,
    customer,
    teller,
    workspace: state.workspace,
    compliance,
    sequence: state.ledger.length + 1,
    now
  });
  const receipt = createReceipt(transaction, customer, teller);
  const nextState: DeskState = {
    ...state,
    ledger: [transaction, ...state.ledger],
    receipts: [receipt, ...state.receipts],
    till: applyTransactionToTill(state.till, transaction)
  };

  return { ok: true, state: nextState, transaction, receipt };
}
