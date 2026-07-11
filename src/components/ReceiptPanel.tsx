import type { Receipt } from "../domain/types";
import { PanelTitle } from "./shared";

export function ReceiptPanel({ receipt }: { receipt: Receipt | undefined }) {
  return (
    <section className="panel receipt-panel">
      <PanelTitle kicker="Receipt" title="Latest receipt" />
      {receipt ? (
        <pre className="receipt" data-testid="receipt">
          {receipt.lines.join("\n")}
        </pre>
      ) : (
        <p className="muted">Post a transaction to generate a receipt.</p>
      )}
    </section>
  );
}
