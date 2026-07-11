import { describe, expect, it } from "vitest";
import { postExchange } from "../../src/domain/posting";
import { createInitialState } from "../../src/domain/seed";
import type { ExchangeDraft } from "../../src/domain/types";

const draft: ExchangeDraft = {
  customerId: "c-jakob-miller",
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash"
};

function signedInState() {
  return { ...createInitialState(), activeUserId: "a.singh" };
}

describe("exchange posting orchestration", () => {
  it("atomically creates the ledger entry, receipt, and till movement", () => {
    const initial = signedInState();
    const result = postExchange(initial, draft, new Date("2026-07-11T12:00:00.000Z"));

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
    const result = postExchange(initial, { ...draft, inputAmount: 100000 }, new Date("2026-07-11T12:00:00.000Z"));

    expect(result).toEqual({ ok: false, reason: "Compliance checks are blocking." });
    expect(initial.ledger).toHaveLength(0);
    expect(initial.receipts).toHaveLength(0);
    expect(initial.till.USD).toBe(12000);
  });

  it("generates unique IDs for consecutive posts at the same timestamp", () => {
    const now = new Date("2026-07-11T12:00:00.000Z");
    const first = postExchange(signedInState(), draft, now);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = postExchange(first.state, draft, now);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.transaction.id).not.toBe(first.transaction.id);
    expect(second.transaction.ref).toBe("CD-260711-002");
  });
});
