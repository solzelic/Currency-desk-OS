import { useMemo, useState } from "react";
import { CustomerPanel } from "./components/CustomerPanel";
import { ComplianceChecklist } from "./components/ComplianceChecklist";
import { ExchangeDraftForm } from "./components/ExchangeDraftForm";
import { LedgerSummary } from "./components/LedgerSummary";
import { ReceiptPanel } from "./components/ReceiptPanel";
import { SignInScreen } from "./components/SignInScreen";
import { TillSummary } from "./components/TillSummary";
import { WorkspaceShell, type DeskApplication } from "./components/WorkspaceShell";
import { runComplianceChecks } from "./domain/compliance";
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
  const [postVersion, setPostVersion] = useState(0);

  const selectedCustomer = state.customers.find((customer) => customer.id === draft.customerId);
  const lastReceipt = state.receipts.find((receipt) => receipt.id === lastReceiptId) ?? state.receipts[0];
  const compliance = useMemo(() => runComplianceChecks(selectedCustomer, draft, state.till), [selectedCustomer, draft, state.till]);

  if (!activeUser) {
    return <SignInScreen staff={state.staff} onSignIn={store.signIn} />;
  }

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
    setPostVersion((current) => current + 1);
    setDraft((current) => ({ ...current, inputAmount: 1000 }));
  }

  const applications: DeskApplication[] = [
    {
      id: "exchange",
      title: "Exchange Desk",
      detail: "Currency exchange",
      icon: "/currencydesk-icons/currencydesk-icon-rate-board.svg",
      accent: "#1d6b45",
      content: (
        <div className="exchange-desk-layout">
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
        </div>
      )
    },
    {
      id: "clients",
      title: "Clients · KYC",
      detail: "Customer records",
      icon: "/currencydesk-icons/currencydesk-icon-clients-kyc.svg",
      accent: "#4d6d82",
      content: <CustomerPanel customers={state.customers} selectedCustomer={selectedCustomer} selectedCustomerId={draft.customerId} onSelectCustomer={(customerId) => updateDraft({ customerId })} onCreateCustomer={(input) => handleCustomerCreated(store.createCustomer(input))} />
    },
    {
      id: "compliance",
      title: "Compliance",
      detail: "Pre-post review",
      icon: "/currencydesk-icons/currencydesk-icon-compliance.svg",
      accent: "#b36a24",
      content: <ComplianceChecklist checks={compliance} />
    },
    {
      id: "ledger",
      title: "Ledger",
      detail: "Posted exchanges",
      icon: "/currencydesk-icons/currencydesk-icon-ledger.svg",
      accent: "#1f2430",
      content: <LedgerSummary ledger={state.ledger} customers={state.customers} />
    },
    {
      id: "receipt",
      title: "Receipt",
      detail: "Transaction confirmation",
      icon: "/currencydesk-icons/currencydesk-icon-cheques.svg",
      accent: "#1d6b45",
      content: <ReceiptPanel receipt={lastReceipt} />
    },
    {
      id: "till",
      title: "Till Drawer",
      detail: "Cash position",
      icon: "/currencydesk-icons/currencydesk-icon-till-drawer.svg",
      accent: "#795b36",
      content: <TillSummary till={state.till} onReset={store.resetDemo} />
    }
  ];

  return (
    <WorkspaceShell
      activeUser={activeUser}
      workspace={state.workspace}
      ledgerCount={state.ledger.length}
      receiptCount={state.receipts.length}
      till={state.till}
      applications={applications}
      postVersion={postVersion}
      onSignOut={store.signOut}
    />
  );
}
