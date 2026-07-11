import type { ComplianceCheck, Customer, ExchangeDraft } from "./types";
import { inputAmountCad, money } from "./rates";

const reportableThresholdCad = 10000;
const idRequiredCad = 3000;

export function runComplianceChecks(customer: Customer | undefined, draft: ExchangeDraft): ComplianceCheck[] {
  const cadAmount = inputAmountCad(draft.from, draft.inputAmount);
  const checks: ComplianceCheck[] = [];

  checks.push({
    id: "amount",
    label: "Amount entered",
    status: draft.inputAmount > 0 ? "pass" : "block",
    detail: draft.inputAmount > 0 ? `${money(cadAmount)} CAD equivalent` : "Enter an amount before posting."
  });

  checks.push({
    id: "customer",
    label: "Customer selected",
    status: customer ? "pass" : "block",
    detail: customer ? customer.name : "Select or create a customer."
  });

  const idRequired = cadAmount >= idRequiredCad;
  checks.push({
    id: "identity",
    label: "Identity policy",
    status: !idRequired || customer?.idStatus === "verified" ? "pass" : "block",
    detail: idRequired
      ? customer?.idStatus === "verified"
        ? "Verified ID is on file."
        : `Verified ID required at ${money(idRequiredCad)} CAD and above.`
      : "ID is not required at this amount."
  });

  const reportable = cadAmount >= reportableThresholdCad;
  checks.push({
    id: "reportable",
    label: "Reportable threshold",
    status: reportable && (!draft.purpose.trim() || !draft.sourceOfFunds.trim()) ? "block" : reportable ? "warn" : "pass",
    detail: reportable
      ? "Large cash transaction. Capture purpose and source of funds before posting."
      : `Below ${money(reportableThresholdCad)} CAD reportable threshold.`
  });

  checks.push({
    id: "risk",
    label: "Risk review",
    status: customer?.risk === "High" ? "warn" : "pass",
    detail: customer?.risk === "High" ? "High-risk customer. Enhanced review recommended." : "No enhanced review required."
  });

  return checks;
}

export function canPost(checks: ComplianceCheck[]): boolean {
  return checks.every((check) => check.status !== "block");
}
