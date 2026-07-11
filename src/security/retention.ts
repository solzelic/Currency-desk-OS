import type { DataClassification } from "./classification";
import type { DomainScope } from "../domain/types";

export type RetentionTrigger = "record_created" | "relationship_ended" | "transaction_posted" | "case_closed";

export interface RetentionPolicy {
  id: string;
  name: string;
  classification: DataClassification;
  trigger: RetentionTrigger;
  minimumDays: number;
  jurisdiction: string;
  policyOwner: string;
  legalConfirmationRequired: true;
}

export interface RetentionAssignment extends DomainScope {
  recordType: string;
  recordId: string;
  policyId: string;
  triggerDate: string;
  retainUntil: string | null;
}

export type LegalHoldStatus = "active" | "released";

export interface LegalHold extends DomainScope {
  id: string;
  name: string;
  status: LegalHoldStatus;
  reason: string;
  issuedAt: string;
  issuedBy: string;
  releasedAt: string | null;
  recordSelectors: readonly { recordType: string; recordId?: string }[];
}

export function isDestructionProhibited(assignment: RetentionAssignment, holds: readonly LegalHold[]): boolean {
  return holds.some((hold) =>
    hold.status === "active"
    && hold.tenantId === assignment.tenantId
    && hold.recordSelectors.some((selector) =>
      selector.recordType === assignment.recordType
      && (!selector.recordId || selector.recordId === assignment.recordId)
    )
  );
}
