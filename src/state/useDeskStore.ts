import { useMemo, useRef, useState } from "react";
import { createInitialState } from "../domain/seed";
import { postExchange as createPostExchange } from "../domain/posting";
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
  const stateRef = useRef(state);

  const activeUser = useMemo(
    () => state.staff.find((user) => user.id === state.activeUserId) ?? null,
    [state.activeUserId, state.staff]
  );

  function commit(next: DeskState): void {
    stateRef.current = next;
    setState(next);
    saveState(next);
  }

  function signIn(staffId: string): void {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === staffId);
    if (user) commit({ ...current, activeUserId: user.id });
  }

  function signOut(): void {
    const current = stateRef.current;
    commit({ ...current, activeUserId: null });
  }

  function createCustomer(input: Pick<Customer, "name" | "phone" | "risk" | "idStatus">): Customer {
    const current = stateRef.current;
    const customer: Customer = {
      id: `c-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now()}`,
      ...input
    };
    commit({ ...current, customers: [customer, ...current.customers] });
    return customer;
  }

  function postExchange(draft: ExchangeDraft) {
    const result = createPostExchange(stateRef.current, draft);
    if (result.ok) commit(result.state);
    return result;
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
