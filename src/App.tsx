import { useState } from "react";
import { apiLogin, apiLogout } from "./api/client";
import { CustomerPanel } from "./components/CustomerPanel";
import { ExchangeDraftForm } from "./components/ExchangeDraftForm";
import { LedgerSummary } from "./components/LedgerSummary";
import { ReceiptPanel } from "./components/ReceiptPanel";
import { SignInScreen } from "./components/SignInScreen";
import { TillSummary } from "./components/TillSummary";
import { WorkspaceShell } from "./components/WorkspaceShell";
import type { Customer, ExchangeDraft } from "./domain/types";
import type { PersistenceAdapter } from "./persistence/types";
import { useDeskStore } from "./state/useDeskStore";

const initialDraft: ExchangeDraft = {
  customerId: "",
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash on hand"
};

export function App({ persistence }: { persistence: PersistenceAdapter }) {
  const store = useDeskStore({ persistence });
  const { state, activeUser } = store;
  const [draft, setDraft] = useState<ExchangeDraft>(initialDraft);
  const [lastReceiptId, setLastReceiptId] = useState<string | null>(null);
  const [postMessage, setPostMessage] = useState("");
  const [signInNotice, setSignInNotice] = useState("");

  // Backend-first sign-in: a real session against server/ when it's running,
  // graceful local demo mode when it isn't (offline dev, CI).
  async function handleSignIn(staffId: string) {
    const result = await apiLogin(staffId);
    if (result.ok) {
      setSignInNotice("");
      store.signIn(staffId);
      return;
    }
    if (result.reason === "unreachable") {
      setSignInNotice("Backend not running — signed in with local demo state.");
      store.signIn(staffId);
      return;
    }
    setSignInNotice("Backend rejected the credentials for this account.");
  }

  function handleSignOut() {
    void apiLogout();
    store.signOut();
  }

  if (!activeUser) {
    return <SignInScreen staff={state.staff} onSignIn={(staffId) => void handleSignIn(staffId)} notice={signInNotice} />;
  }

  const selectedCustomer = state.customers.find((customer) => customer.id === draft.customerId);
  const lastReceipt = state.receipts.find((receipt) => receipt.id === lastReceiptId) ?? state.receipts[0];

  function updateDraft(patch: Partial<ExchangeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setPostMessage("");
  }

  function handleCustomerCreated(customer: Customer) {
    setDraft((current) => ({ ...current, customerId: customer.id }));
    setPostMessage(`Created ${customer.name}.`);
  }

  function postTransaction() {
    const result = store.postExchange(draft);
    if (!result.ok) {
      setPostMessage(result.reason);
      return;
    }

    setLastReceiptId(result.receipt.id);
    setPostMessage(`Posted ${result.transaction.ref}.`);
    setDraft((current) => ({ ...current, inputAmount: 1000 }));
  }

  return (
    <WorkspaceShell
      activeUser={activeUser}
      workspace={state.workspace}
      ledgerCount={state.ledger.length}
      receiptCount={state.receipts.length}
      till={state.till}
      onSignOut={handleSignOut}
    >
      <CustomerPanel
        customers={state.customers}
        selectedCustomer={selectedCustomer}
        selectedCustomerId={draft.customerId}
        onSelectCustomer={(customerId) => updateDraft({ customerId })}
        onCreateCustomer={(input) => handleCustomerCreated(store.createCustomer(input))}
      />
      <ExchangeDraftForm
        draft={draft}
        selectedCustomer={selectedCustomer}
        till={state.till}
        postMessage={postMessage}
        onDraftChange={updateDraft}
        onPost={postTransaction}
      />
      <LedgerSummary ledger={state.ledger} customers={state.customers} />
      <ReceiptPanel receipt={lastReceipt} />
      <TillSummary till={state.till} onReset={store.resetDemo} />
    </WorkspaceShell>
  );
}
