import { describe, expect, it } from "vitest";
import { postExchange } from "../../src/domain/posting";
import { createInitialState } from "../../src/domain/seed";
import type { DeskState, ExchangeDraft, StaffUser } from "../../src/domain/types";

const draft: ExchangeDraft = {
  customerId: "c-jakob-miller",
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash"
};

function signedInState(): DeskState {
  return { ...createInitialState(), activeUserId: "a.singh" };
}

function actorFor(state = signedInState()): StaffUser {
  return state.staff.find((staff) => staff.id === state.activeUserId)!;
}

function post(state = signedInState(), actor = actorFor(state), now = new Date("2026-07-11T12:00:00.000Z")) {
  return postExchange({ state, draft, actor, now });
}

describe("exchange posting orchestration", () => {
  it("allows an authorized teller to create the ledger entry, receipt, and till movement", () => {
    const initial = signedInState();
    const result = post(initial);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(initial.ledger).toHaveLength(0);
    expect(result.state.ledger[0]).toBe(result.transaction);
    expect(result.state.receipts[0]).toBe(result.receipt);
    expect(result.receipt.transactionId).toBe(result.transaction.id);
    expect(result.state.till.CAD).toBe(26000);
    expect(result.state.till.USD).toBe(11275.58);
  });

  it("leaves state unchanged when posting is blocked", () => {
    const initial = signedInState();
    const result = postExchange({
      state: initial,
      draft: { ...draft, inputAmount: 100000 },
      actor: actorFor(initial),
      now: new Date("2026-07-11T12:00:00.000Z")
    });

    expect(result).toEqual({ ok: false, reason: "Compliance checks are blocking." });
    expect(initial.ledger).toHaveLength(0);
    expect(initial.receipts).toHaveLength(0);
    expect(initial.till.USD).toBe(12000);
  });

  it("generates unique IDs for consecutive posts at the same timestamp", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const initial = signedInState();
    const first = post(initial, actorFor(initial), now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = post(first.state, actorFor(first.state), now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.transaction.id).not.toBe(first.transaction.id);
    expect(second.transaction.ref).toBe("CD-260711-002");
  });

  it("rejects a direct posting-helper call from an unauthorized role", () => {
    const initial = signedInState();
    const auditor = { ...actorFor(initial), role: "auditor" as const };
    initial.staff = initial.staff.map((staff) => staff.id === auditor.id ? auditor : staff);

    expect(post(initial, auditor)).toEqual({
      ok: false,
      reason: "Posting authorization denied: permission_denied."
    });
    expect(initial.ledger).toHaveLength(0);
  });

  it("rejects actors outside the active tenant or branch", () => {
    const tenantState = signedInState();
    expect(post(tenantState, { ...actorFor(tenantState), tenantId: "tenant-other" })).toEqual({
      ok: false,
      reason: "Actor is not valid for the active workspace."
    });

    const branchState = signedInState();
    const branchRestrictedActor = { ...actorFor(branchState), authorizedBranchIds: ["branch-other"] };
    branchState.staff = branchState.staff.map((staff) => staff.id === branchRestrictedActor.id ? branchRestrictedActor : staff);
    expect(post(branchState, branchRestrictedActor)).toEqual({
      ok: false,
      reason: "Posting authorization denied: branch_denied."
    });
  });
});
