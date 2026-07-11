import { useMemo, useRef, useState } from "react";
import { createInitialState, defaultScope } from "../domain/seed";
import { postExchange as postAuthorizedExchange } from "../domain/posting";
import type { Customer, DeskState, DomainScope, ExchangeDraft, StaffUser } from "../domain/types";
import type { PersistenceAdapter } from "../persistence/types";
import { auditStateReference, createAuditEvent } from "../security/audit";
import type { AuditActor, AuditEvent, AuditTarget } from "../security/audit";
import { isSameWorkspace } from "../security/tenantIsolation";

export interface DeskStoreDependencies {
  persistence: PersistenceAdapter;
  scope?: DomainScope;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

function defaultCreateId(prefix: string): string {
  const value = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${value}`;
}

export function useDeskStore({
  persistence,
  scope = defaultScope,
  now = () => new Date(),
  createId = defaultCreateId
}: DeskStoreDependencies) {
  const [state, setState] = useState<DeskState>(() => persistence.state.load(scope) ?? createInitialState(scope));
  const stateRef = useRef(state);

  const activeUser = useMemo(
    () => state.staff.find((user) => user.id === state.activeUserId) ?? null,
    [state.activeUserId, state.staff]
  );

  function actorFor(user: StaffUser | null | undefined): AuditActor {
    return user ? { id: user.id, role: user.role } : { id: "anonymous", role: "anonymous" };
  }

  function eventFor(params: {
    state: DeskState;
    actor: AuditActor;
    action: AuditEvent["action"];
    target: AuditTarget;
    reason: string;
    previousState: AuditEvent["previousState"];
    newState: AuditEvent["newState"];
    occurredAt?: Date;
    correlationId?: string;
  }): AuditEvent {
    const occurredAt = params.occurredAt ?? now();
    return createAuditEvent(
      {
        ...params.state.scope,
        actor: params.actor,
        action: params.action,
        target: params.target,
        reason: params.reason,
        correlationId: params.correlationId ?? createId("correlation"),
        previousState: params.previousState,
        newState: params.newState
      },
      { now: () => occurredAt, createId: () => createId("audit") }
    );
  }

  function commit(next: DeskState, event: AuditEvent): void {
    const current = stateRef.current;
    persistence.state.save(next);
    try {
      persistence.audit.append(event);
    } catch (error) {
      persistence.state.save(current);
      throw error;
    }
    stateRef.current = next;
    setState(next);
  }

  function signIn(staffId: string): void {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === staffId);
    if (!user || !isSameWorkspace(current.scope, user)) return;

    const occurredAt = now();
    const target: AuditTarget = { type: "session", id: user.id };
    const next = { ...current, activeUserId: user.id };
    commit(next, eventFor({
      state: current,
      actor: actorFor(user),
      action: "session.sign_in",
      target,
      reason: "Interactive demo sign-in.",
      previousState: null,
      newState: auditStateReference(target, occurredAt.toISOString()),
      occurredAt
    }));
  }

  function signOut(): void {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === current.activeUserId);
    if (!user) return;

    const occurredAt = now();
    const target: AuditTarget = { type: "session", id: user.id };
    const next = { ...current, activeUserId: null };
    commit(next, eventFor({
      state: current,
      actor: actorFor(user),
      action: "session.sign_out",
      target,
      reason: "Workspace locked by the signed-in user.",
      previousState: auditStateReference(target, occurredAt.toISOString()),
      newState: null,
      occurredAt
    }));
  }

  function createCustomer(input: Pick<Customer, "name" | "phone" | "risk" | "idStatus">): Customer {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === current.activeUserId);
    if (!user) throw new Error("An active user is required to create a customer.");

    const occurredAt = now();
    const customer: Customer = { ...current.scope, id: createId("customer"), ...input };
    const target: AuditTarget = { type: "customer", id: customer.id };
    const next = { ...current, customers: [customer, ...current.customers] };
    commit(next, eventFor({
      state: current,
      actor: actorFor(user),
      action: "customer.create",
      target,
      reason: "Customer record created in the active workspace.",
      previousState: null,
      newState: auditStateReference(target, occurredAt.toISOString()),
      occurredAt
    }));
    return customer;
  }

  function postExchange(draft: ExchangeDraft) {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === current.activeUserId);
    const occurredAt = now();
    const correlationId = createId("correlation");
    const failedTarget: AuditTarget = { type: "transaction", id: `draft-${draft.customerId || "unassigned"}` };

    function fail(reason: string) {
      persistence.audit.append(eventFor({
        state: current,
        actor: actorFor(user),
        action: "transaction.post_failed",
        target: failedTarget,
        reason,
        previousState: null,
        newState: null,
        occurredAt,
        correlationId
      }));
      return { ok: false as const, reason };
    }

    if (!user) return fail("Missing active user.");

    const result = postAuthorizedExchange({ state: current, draft, actor: user, now: occurredAt });
    if (!result.ok) return fail(result.reason);

    const target: AuditTarget = { type: "transaction", id: result.transaction.id };
    commit(result.state, eventFor({
      state: current,
      actor: actorFor(user),
      action: "transaction.post",
      target,
      reason: "Currency exchange posted after authorization and compliance checks.",
      previousState: null,
      newState: auditStateReference(target, result.transaction.postedAt),
      occurredAt,
      correlationId
    }));
    return result;
  }

  function resetDemo(): void {
    const current = stateRef.current;
    const user = current.staff.find((item) => item.id === current.activeUserId);
    const occurredAt = now();
    const target: AuditTarget = { type: "workspace", id: current.workspace.workspaceId };
    const next = createInitialState(current.scope);
    commit(next, eventFor({
      state: current,
      actor: actorFor(user),
      action: "demo.reset",
      target,
      reason: "Demo workspace state reset. Audit history retained.",
      previousState: auditStateReference(target, occurredAt.toISOString()),
      newState: auditStateReference(target, occurredAt.toISOString()),
      occurredAt
    }));
  }

  return { state, activeUser, signIn, signOut, createCustomer, postExchange, resetDemo };
}
