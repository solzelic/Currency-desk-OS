import type { DeskState, DomainScope } from "../domain/types";

export function tenantKey(scope: DomainScope): string {
  return [scope.tenantId, scope.legalEntityId, scope.branchId, scope.workspaceId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function isSameTenant(left: DomainScope, right: DomainScope): boolean {
  return left.tenantId === right.tenantId;
}

export function isSameLegalEntity(left: DomainScope, right: DomainScope): boolean {
  return isSameTenant(left, right) && left.legalEntityId === right.legalEntityId;
}

export function isSameWorkspace(left: DomainScope, right: DomainScope): boolean {
  return isSameLegalEntity(left, right)
    && left.branchId === right.branchId
    && left.workspaceId === right.workspaceId;
}

export function assertSameTenant(expected: DomainScope, actual: DomainScope): void {
  if (!isSameTenant(expected, actual)) {
    throw new Error("Tenant boundary violation.");
  }
}

export function assertSameWorkspace(expected: DomainScope, actual: DomainScope): void {
  if (!isSameWorkspace(expected, actual)) {
    throw new Error("Workspace boundary violation.");
  }
}

export function assertDeskStateIsolation(state: DeskState): void {
  assertSameWorkspace(state.scope, state.workspace);
  for (const record of [...state.staff, ...state.customers, ...state.ledger, ...state.receipts]) {
    assertSameWorkspace(state.scope, record);
  }
}
