import type { DomainScope, StaffRole, StaffUser } from "../domain/types";
import { isSameLegalEntity } from "./tenantIsolation";

export type Permission =
  | "transaction:post"
  | "compliance:override_warning"
  | "transaction:reverse"
  | "customer:view_sensitive"
  | "records:export"
  | "rates:change";

export const rolePermissions: Readonly<Record<StaffRole, readonly Permission[]>> = {
  teller: ["transaction:post", "customer:view_sensitive"],
  supervisor: [
    "transaction:post",
    "compliance:override_warning",
    "transaction:reverse",
    "customer:view_sensitive",
    "rates:change"
  ],
  compliance_officer: ["compliance:override_warning", "customer:view_sensitive", "records:export"],
  branch_manager: [
    "transaction:post",
    "compliance:override_warning",
    "transaction:reverse",
    "customer:view_sensitive",
    "records:export",
    "rates:change"
  ],
  administrator: [
    "transaction:post",
    "compliance:override_warning",
    "transaction:reverse",
    "customer:view_sensitive",
    "records:export",
    "rates:change"
  ],
  auditor: ["customer:view_sensitive", "records:export"]
};

export interface AuthorizationDecision {
  allowed: boolean;
  reason: "allowed" | "permission_denied" | "tenant_denied" | "branch_denied";
}

export function authorize(actor: StaffUser, permission: Permission, target: DomainScope): AuthorizationDecision {
  if (!isSameLegalEntity(actor, target)) {
    return { allowed: false, reason: "tenant_denied" };
  }

  if (!actor.authorizedBranchIds.includes(target.branchId)) {
    return { allowed: false, reason: "branch_denied" };
  }

  if (!rolePermissions[actor.role].includes(permission)) {
    return { allowed: false, reason: "permission_denied" };
  }

  return { allowed: true, reason: "allowed" };
}

export function canPostTransactions(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "transaction:post", target).allowed;
}

export function canOverrideComplianceWarnings(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "compliance:override_warning", target).allowed;
}

export function canReverseTransactions(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "transaction:reverse", target).allowed;
}

export function canViewSensitiveCustomerData(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "customer:view_sensitive", target).allowed;
}

export function canExportRecords(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "records:export", target).allowed;
}

export function canChangeRates(actor: StaffUser, target: DomainScope): boolean {
  return authorize(actor, "rates:change", target).allowed;
}
