import { useMemo, useState } from "react";
import { createInitialState } from "../domain/seed";
import { canPost, runComplianceChecks } from "../domain/compliance";
import { applyTransactionToTill, createReceipt, postExchangeTransaction } from "../domain/transactions";
import type { Customer, DeskState, ExchangeDraft } from "../domain/types";

const storageKey = "cdos_frontend_foundation_v1";

function loadState(): DeskState {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? { ...createInitialState(), ...JSON.parse(raw) } : createInitialState();
  } catch {
    return createInitialState();
  }
}

function saveState(state: DeskState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Storage can be disabled in private browser contexts; keep the session usable.
  }
}

export function useDeskStore() {
  const [state, setState] = useState<DeskState>(() => loadState());

  const activeUser = useMemo(
    () => state.staff.find((user) => user.id === state.activeUserId) ?? null,
    [state.activeUserId, state.staff]
  );

  function commit(next: DeskState): void {
    setState(next);
    saveState(next);
  }

  function signIn(staffId: string): void {
    const user = state.staff.find((item) => item.id === staffId) ?? state.staff[0];
    commit({ ...state, activeUserId: user.id });
  }

  function signOut(): void {
    commit({ ...state, activeUserId: null });
  }

  function createCustomer(input: Pick<Customer, "name" | "phone" | "risk" | "idStatus">): Customer {
    const customer: Customer = {
      id: `c-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now()}`,
      ...input
    };
    commit({ ...state, customers: [customer, ...state.customers] });
    return customer;
  }

  function postExchange(draft: ExchangeDraft) {
    const customer = state.customers.find((item) => item.id === draft.customerId);
    if (!customer || !activeUser) {
      return { ok: false as const, reason: "Missing customer or active user." };
    }

    const compliance = runComplianceChecks(customer, draft);
    if (!canPost(compliance)) {
      return { ok: false as const, reason: "Compliance checks are blocking.", compliance };
    }

    const tx = postExchangeTransaction({
      draft,
      customer,
      teller: activeUser,
      compliance,
      sequence: state.ledger.length + 1
    });
    const receipt = createReceipt(tx, customer, activeUser);
    const next: DeskState = {
      ...state,
      ledger: [tx, ...state.ledger],
      receipts: [receipt, ...state.receipts],
      till: applyTransactionToTill(state.till, tx)
    };
    commit(next);
    return { ok: true as const, transaction: tx, receipt };
  }

  function resetDemo(): void {
    const next = createInitialState();
    commit(next);
  }

  return {
    state,
    activeUser,
    signIn,
    signOut,
    createCustomer,
    postExchange,
    resetDemo
  };
}
