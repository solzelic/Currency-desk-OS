import { money } from "../domain/rates";
import type { CurrencyCode, TillPosition } from "../domain/types";
import { Metric, PanelTitle } from "./shared";

export function TillSummary({ till, onReset }: { till: TillPosition; onReset: () => void }) {
  return (
    <section className="panel">
      <PanelTitle kicker="Till" title="Cash position" />
      <div className="till-grid" data-testid="till-summary">
        {Object.entries(till).map(([currency, amount]) => (
          <Metric key={currency} label={currency} value={money(amount, currency as CurrencyCode)} />
        ))}
      </div>
      <button className="secondary" onClick={onReset}>
        Reset demo state
      </button>
    </section>
  );
}
