import { useMemo } from "react";
import { runComplianceChecks } from "../domain/compliance";
import { money, quoteExchange } from "../domain/rates";
import type { CurrencyCode, Customer, ExchangeDraft, TillPosition } from "../domain/types";
import { ComplianceChecklist } from "./ComplianceChecklist";
import { PanelTitle } from "./shared";

const currencies: CurrencyCode[] = ["CAD", "USD", "EUR", "GBP"];

export function ExchangeDraftForm({
  draft,
  selectedCustomer,
  till,
  postMessage,
  onDraftChange,
  onPost
}: {
  draft: ExchangeDraft;
  selectedCustomer: Customer | undefined;
  till: TillPosition;
  postMessage: string;
  onDraftChange: (patch: Partial<ExchangeDraft>) => void;
  onPost: () => void;
}) {
  const quote = quoteExchange(draft.from, draft.to, draft.inputAmount, draft.feeCad);
  const compliance = useMemo(
    () => runComplianceChecks(selectedCustomer, draft, till),
    [selectedCustomer, draft, till]
  );
  const blockingCount = compliance.filter((check) => check.status === "block").length;

  return (
    <>
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
              onChange={(event) => onDraftChange({ inputAmount: Number(event.target.value) })}
              data-testid="input-amount"
            />
          </label>
          <label>
            Fee CAD
            <input
              type="number"
              min="0"
              step="0.01"
              value={draft.feeCad}
              onChange={(event) => onDraftChange({ feeCad: Number(event.target.value) })}
              data-testid="fee-cad"
            />
          </label>
        </div>

        <div className="two-col">
          <label>
            From
            <select
              value={draft.from}
              onChange={(event) => {
                const from = event.target.value as CurrencyCode;
                const to = from === draft.to ? currencies.find((currency) => currency !== from) ?? draft.to : draft.to;
                onDraftChange({ from, to });
              }}
              data-testid="from-currency"
            >
              {currencies.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <label>
            To
            <select
              value={draft.to}
              onChange={(event) => onDraftChange({ to: event.target.value as CurrencyCode })}
              data-testid="to-currency"
            >
              {currencies
                .filter((currency) => currency !== draft.from)
                .map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
            </select>
          </label>
        </div>

        <div className="quote-box" data-testid="quote-box">
          <span>Customer receives</span>
          <strong>{money(quote.outputAmount, draft.to)}</strong>
          <small>
            1 {draft.from} = {quote.rate.toFixed(4)} {draft.to} · profit {money(quote.totalProfitCad)}
          </small>
        </div>

        <div className="two-col">
          <label>
            Purpose
            <input value={draft.purpose} onChange={(event) => onDraftChange({ purpose: event.target.value })} />
          </label>
          <label>
            Source of funds
            <input value={draft.sourceOfFunds} onChange={(event) => onDraftChange({ sourceOfFunds: event.target.value })} />
          </label>
        </div>

        <button className="post-button" disabled={blockingCount > 0} onClick={onPost} data-testid="post-transaction">
          {blockingCount > 0 ? `${blockingCount} compliance item${blockingCount === 1 ? "" : "s"} blocking` : "Post transaction"}
        </button>
        {postMessage && <p className="status-line">{postMessage}</p>}
      </section>

      <ComplianceChecklist checks={compliance} />
    </>
  );
}
