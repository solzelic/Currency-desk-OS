import type { ComplianceCheck, Customer, ExchangeDraft, TillPosition } from "./types";
import { inputAmountCad, money, quoteExchange } from "./rates";

const reportableThresholdCad = 10000;
const idRequiredCad = 3000;

export function runComplianceChecks(
  customer: Customer | undefined,
  draft: ExchangeDraft,
  till: TillPosition
): ComplianceCheck[] {
  const cadAmount = inputAmountCad(draft.from, draft.inputAmount);
  const checks: ComplianceCheck[] = [];
  const validAmount = Number.isFinite(draft.inputAmount) && draft.inputAmount > 0;
  const validFee = Number.isFinite(draft.feeCad) && draft.feeCad >= 0;

  checks.push({
    id: "amount",
    label: "Amount entered",
    status: validAmount ? "pass" : "block",
    detail: validAmount ? `${money(cadAmount)} CAD equivalent` : "Enter a valid amount greater than zero."
  });

  checks.push({
    id: "fee",
    label: "Fee entered",
    status: validFee ? "pass" : "block",
    detail: validFee ? `${money(draft.feeCad)} fee` : "Enter a valid fee of zero or more."
  });

  checks.push({
    id: "currency",
    label: "Currency pair",
    status: draft.from !== draft.to ? "pass" : "block",
    detail: draft.from !== draft.to ? `${draft.from} to ${draft.to}` : "Source and destination currencies must differ."
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
      ? draft.purpose.trim() && draft.sourceOfFunds.trim()
        ? "Large cash transaction. Required details are captured for reporting."
        : "Large cash transaction. Capture purpose and source of funds before posting."
      : `Below ${money(reportableThresholdCad)} CAD reportable threshold.`
  });

  checks.push({
    id: "risk",
    label: "Risk review",
    status: customer?.risk === "High" ? "warn" : "pass",
    detail: customer?.risk === "High" ? "High-risk customer. Enhanced review recommended." : "No enhanced review required."
  });

  const outputAmount = quoteExchange(draft.from, draft.to, draft.inputAmount, draft.feeCad).outputAmount;
  const availableAmount = till[draft.to] ?? 0;
  const hasLiquidity = Number.isFinite(outputAmount) && outputAmount > 0 && availableAmount >= outputAmount;
  checks.push({
    id: "liquidity",
    label: "Till liquidity",
    status: hasLiquidity ? "pass" : "block",
    detail: hasLiquidity
      ? `${money(availableAmount, draft.to)} available`
      : `Insufficient ${draft.to} cash in the till.`
  });

  return checks;
}

export function canPost(checks: ComplianceCheck[]): boolean {
  return checks.every((check) => check.status !== "block");
}
