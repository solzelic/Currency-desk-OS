import { FormEvent, useMemo, useState } from "react";
import { runComplianceChecks } from "./domain/compliance";
import { money, quoteExchange } from "./domain/rates";
import type { CurrencyCode, Customer, ExchangeDraft } from "./domain/types";
import { useDeskStore } from "./state/useDeskStore";

const currencies: CurrencyCode[] = ["CAD", "USD", "EUR", "GBP"];

const initialDraft: ExchangeDraft = {
  customerId: "",
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash on hand"
};

export function App() {
  const store = useDeskStore();
  const { state, activeUser } = store;
  const [draft, setDraft] = useState<ExchangeDraft>(initialDraft);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerRisk, setCustomerRisk] = useState<Customer["risk"]>("Normal");
  const [customerIdStatus, setCustomerIdStatus] = useState<Customer["idStatus"]>("verified");
  const [lastReceiptId, setLastReceiptId] = useState<string | null>(null);
  const [postMessage, setPostMessage] = useState("");

  const selectedCustomer = state.customers.find((customer) => customer.id === draft.customerId);
  const quote = quoteExchange(draft.from, draft.to, draft.inputAmount, draft.feeCad);
  const compliance = useMemo(() => runComplianceChecks(selectedCustomer, draft), [selectedCustomer, draft]);
  const blockingCount = compliance.filter((check) => check.status === "block").length;
  const warningCount = compliance.filter((check) => check.status === "warn").length;
  const lastReceipt = state.receipts.find((receipt) => receipt.id === lastReceiptId) ?? state.receipts[0];

  if (!activeUser) {
    return (
      <main className="auth-screen">
        <section className="auth-panel">
          <p className="eyebrow">CurrencyDesk OS</p>
          <h1>Desk workspace</h1>
          <p className="muted">Choose a staff account to enter the TypeScript frontend foundation.</p>
          <div className="staff-list">
            {state.staff.map((staff) => (
              <button key={staff.id} className="staff-button" onClick={() => store.signIn(staff.id)}>
                <span>{staff.name}</span>
                <small>{staff.role}</small>
              </button>
            ))}
          </div>
        </section>
      </main>
    );
  }

  function updateDraft(patch: Partial<ExchangeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setPostMessage("");
  }

  function createCustomer(event: FormEvent) {
    event.preventDefault();
    if (!customerName.trim()) return;
    const customer = store.createCustomer({
      name: customerName.trim(),
      phone: customerPhone.trim() || undefined,
      risk: customerRisk,
      idStatus: customerIdStatus
    });
    setDraft((current) => ({ ...current, customerId: customer.id }));
    setCustomerName("");
    setCustomerPhone("");
    setCustomerRisk("Normal");
    setCustomerIdStatus("verified");
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
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">CurrencyDesk OS</p>
          <h1>{state.workspace.branchName}</h1>
        </div>
        <div className="session-card">
          <span>{activeUser.name}</span>
          <small>{state.workspace.tillId} · {state.workspace.businessDate}</small>
          <button onClick={store.signOut}>Lock</button>
        </div>
      </header>

      <section className="summary-strip">
        <Metric label="Ledger" value={String(state.ledger.length)} />
        <Metric label="Receipts" value={String(state.receipts.length)} />
        <Metric label="CAD till" value={money(state.till.CAD || 0)} />
        <Metric label="USD till" value={money(state.till.USD || 0, "USD")} />
      </section>

      <div className="grid">
        <section className="panel">
          <PanelTitle kicker="Customer" title="Select or create customer" />
          <label>
            Existing customer
            <select value={draft.customerId} onChange={(event) => updateDraft({ customerId: event.target.value })}>
              <option value="">Select customer</option>
              {state.customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name} · {customer.risk} · {customer.idStatus}
                </option>
              ))}
            </select>
          </label>

          {selectedCustomer && (
            <div className="customer-card">
              <strong>{selectedCustomer.name}</strong>
              <span>{selectedCustomer.risk} risk</span>
              <span>ID {selectedCustomer.idStatus}</span>
            </div>
          )}

          <form className="create-form" onSubmit={createCustomer}>
            <label>
              New customer name
              <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer or business name" />
            </label>
            <label>
              Phone
              <input value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Optional" />
            </label>
            <div className="two-col">
              <label>
                Risk
                <select value={customerRisk} onChange={(event) => setCustomerRisk(event.target.value as Customer["risk"])}>
                  {["Low", "Normal", "Medium", "High"].map((risk) => <option key={risk}>{risk}</option>)}
                </select>
              </label>
              <label>
                ID status
                <select value={customerIdStatus} onChange={(event) => setCustomerIdStatus(event.target.value as Customer["idStatus"])}>
                  <option value="verified">Verified</option>
                  <option value="on-file">On file</option>
                  <option value="missing">Missing</option>
                  <option value="expired">Expired</option>
                </select>
              </label>
            </div>
            <button type="submit" className="secondary">Create customer</button>
          </form>
        </section>

        <section className="panel primary-panel">
          <PanelTitle kicker="Transaction" title="Currency exchange" />
          <div className="two-col">
            <label>
              Customer pays
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.inputAmount}
                onChange={(event) => updateDraft({ inputAmount: Number(event.target.value) })}
              />
            </label>
            <label>
              Fee CAD
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.feeCad}
                onChange={(event) => updateDraft({ feeCad: Number(event.target.value) })}
              />
            </label>
          </div>

          <div className="two-col">
            <label>
              From
              <select value={draft.from} onChange={(event) => updateDraft({ from: event.target.value as CurrencyCode })}>
                {currencies.map((currency) => <option key={currency}>{currency}</option>)}
              </select>
            </label>
            <label>
              To
              <select value={draft.to} onChange={(event) => updateDraft({ to: event.target.value as CurrencyCode })}>
                {currencies.filter((currency) => currency !== draft.from).map((currency) => <option key={currency}>{currency}</option>)}
              </select>
            </label>
          </div>

          <div className="quote-box">
            <span>Customer receives</span>
            <strong>{money(quote.outputAmount, draft.to)}</strong>
            <small>1 {draft.from} = {quote.rate.toFixed(4)} {draft.to} · profit {money(quote.totalProfitCad)}</small>
          </div>

          <div className="two-col">
            <label>
              Purpose
              <input value={draft.purpose} onChange={(event) => updateDraft({ purpose: event.target.value })} />
            </label>
            <label>
              Source of funds
              <input value={draft.sourceOfFunds} onChange={(event) => updateDraft({ sourceOfFunds: event.target.value })} />
            </label>
          </div>

          <button className="post-button" disabled={blockingCount > 0} onClick={postTransaction}>
            {blockingCount > 0 ? `${blockingCount} compliance item${blockingCount === 1 ? "" : "s"} blocking` : "Post transaction"}
          </button>
          {postMessage && <p className="status-line">{postMessage}</p>}
        </section>

        <section className="panel">
          <PanelTitle kicker="Compliance" title="Live checks" />
          <div className="check-list">
            {compliance.map((check) => (
              <div key={check.id} className={`check ${check.status}`}>
                <strong>{check.label}</strong>
                <span>{check.detail}</span>
              </div>
            ))}
          </div>
          <div className="compliance-summary">
            <Metric label="Blocks" value={String(blockingCount)} />
            <Metric label="Warnings" value={String(warningCount)} />
          </div>
        </section>

        <section className="panel ledger-panel">
          <PanelTitle kicker="Ledger" title="Posted transactions" />
          <div className="ledger-list">
            {state.ledger.length === 0 ? <p className="muted">No transactions posted yet.</p> : state.ledger.map((tx) => {
              const customer = state.customers.find((item) => item.id === tx.customerId);
              return (
                <article key={tx.id} className="ledger-row">
                  <strong>{tx.ref}</strong>
                  <span>{customer?.name ?? "Unknown customer"}</span>
                  <span>{money(tx.inputAmount, tx.from)} -> {money(tx.outputAmount, tx.to)}</span>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel receipt-panel">
          <PanelTitle kicker="Receipt" title="Latest receipt" />
          {lastReceipt ? (
            <pre className="receipt">{lastReceipt.lines.join("\n")}</pre>
          ) : (
            <p className="muted">Post a transaction to generate a receipt.</p>
          )}
        </section>

        <section className="panel">
          <PanelTitle kicker="Till" title="Cash position" />
          <div className="till-grid">
            {Object.entries(state.till).map(([currency, amount]) => (
              <Metric key={currency} label={currency} value={money(amount, currency as CurrencyCode)} />
            ))}
          </div>
          <button className="secondary" onClick={store.resetDemo}>Reset demo state</button>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelTitle({ kicker, title }: { kicker: string; title: string }) {
  return (
    <div className="panel-title">
      <span>{kicker}</span>
      <h2>{title}</h2>
    </div>
  );
}
