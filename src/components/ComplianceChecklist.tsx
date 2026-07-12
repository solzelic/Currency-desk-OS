import type { ComplianceCheck } from "../domain/types";
import { Metric, PanelTitle } from "./shared";

export function ComplianceChecklist({ checks }: { checks: ComplianceCheck[] }) {
  const blockingCount = checks.filter((check) => check.status === "block").length;
  const warningCount = checks.filter((check) => check.status === "warn").length;

  return (
    <section className="panel">
      <PanelTitle kicker="Compliance" title="Live checks" />
      <div className="check-list" data-testid="compliance-checks">
        {checks.map((check) => (
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
  );
}
