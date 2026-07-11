import type { ReactNode } from "react";
import { money } from "../domain/rates";
import type { StaffUser, TillPosition, Workspace } from "../domain/types";
import { Metric } from "./shared";

export function WorkspaceShell({
  activeUser,
  workspace,
  ledgerCount,
  receiptCount,
  till,
  onSignOut,
  children
}: {
  activeUser: StaffUser;
  workspace: Workspace;
  ledgerCount: number;
  receiptCount: number;
  till: TillPosition;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <main className="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">CurrencyDesk OS</p>
          <h1>{workspace.branchName}</h1>
        </div>
        <div className="session-card">
          <span>{activeUser.name}</span>
          <small>{workspace.tillId} · {workspace.businessDate}</small>
          <button onClick={onSignOut}>Lock</button>
        </div>
      </header>

      <section className="summary-strip">
        <Metric label="Ledger" value={String(ledgerCount)} />
        <Metric label="Receipts" value={String(receiptCount)} />
        <Metric label="CAD till" value={money(till.CAD || 0)} />
        <Metric label="USD till" value={money(till.USD || 0, "USD")} />
      </section>

      <div className="grid">{children}</div>
    </main>
  );
}
