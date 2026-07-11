import { canPost, runComplianceChecks } from "./compliance";
import { applyTransactionToTill, createReceipt, postExchangeTransaction } from "./transactions";
import type { DeskState, ExchangeDraft, LedgerTransaction, Receipt, StaffUser } from "./types";
import { authorize } from "../security/authorization";
import { isSameWorkspace } from "../security/tenantIsolation";

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

export interface PostExchangeCommand {
  state: DeskState;
  draft: ExchangeDraft;
  actor: StaffUser;
  now?: Date;
}

export function postExchange({ state, draft, actor, now }: PostExchangeCommand): PostExchangeResult {
  const registeredActor = state.staff.find((item) => item.id === actor.id);
  if (
    !registeredActor
    || registeredActor.role !== actor.role
    || !isSameWorkspace(state.scope, actor)
    || !isSameWorkspace(registeredActor, actor)
  ) {
    return { ok: false, reason: "Actor is not valid for the active workspace." };
  }

  if (state.activeUserId !== actor.id) {
    return { ok: false, reason: "Actor is not active in the current workspace." };
  }

  const authorization = authorize(registeredActor, "transaction:post", state.workspace);
  if (!authorization.allowed) {
    return { ok: false, reason: `Posting authorization denied: ${authorization.reason}.` };
  }

  const customer = state.customers.find((item) => item.id === draft.customerId);

  if (!customer) {
    return { ok: false, reason: "Missing customer." };
  }
  if (!isSameWorkspace(state.workspace, customer)) {
    return { ok: false, reason: "Customer is outside the active workspace." };
  }

  const compliance = runComplianceChecks(customer, draft, state.till);
  if (!canPost(compliance)) {
    return { ok: false, reason: "Compliance checks are blocking." };
  }

  const transaction = postExchangeTransaction({
    draft,
    customer,
    teller: registeredActor,
    workspace: state.workspace,
    compliance,
    sequence: state.ledger.length + 1,
    now
  });
  const receipt = createReceipt(transaction, customer, registeredActor);
  const nextState: DeskState = {
    ...state,
    ledger: [transaction, ...state.ledger],
    receipts: [receipt, ...state.receipts],
    till: applyTransactionToTill(state.till, transaction)
  };

  return { ok: true, state: nextState, transaction, receipt };
}
