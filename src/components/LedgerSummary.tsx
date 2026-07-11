import { money } from "../domain/rates";
import type { Customer, LedgerTransaction } from "../domain/types";
import { PanelTitle } from "./shared";

export function LedgerSummary({ ledger, customers }: { ledger: LedgerTransaction[]; customers: Customer[] }) {
  return (
    <section className="panel ledger-panel">
      <PanelTitle kicker="Ledger" title="Posted transactions" />
      <div className="ledger-list" data-testid="ledger-list">
        {ledger.length === 0 ? (
          <p className="muted">No transactions posted yet.</p>
        ) : (
          ledger.map((tx) => {
            const customer = customers.find((item) => item.id === tx.customerId);
            return (
              <article key={tx.id} className="ledger-row">
                <strong>{tx.ref}</strong>
                <span>{customer?.name ?? "Unknown customer"}</span>
                <span>
                  {money(tx.inputAmount, tx.from)} {"->"} {money(tx.outputAmount, tx.to)}
                </span>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
