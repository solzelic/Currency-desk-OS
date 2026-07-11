// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultScope } from "../../src/domain/seed";
import type { Customer, ExchangeDraft } from "../../src/domain/types";
import { InMemoryPersistenceAdapter } from "../../src/persistence/memory";
import { useDeskStore } from "../../src/state/useDeskStore";

describe("desk store audit emission", () => {
  it("records required successful, failed, session, and reset actions", () => {
    const persistence = new InMemoryPersistenceAdapter();
    let sequence = 0;
    const { result } = renderHook(() => useDeskStore({
      persistence,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      createId: (prefix) => `${prefix}-${++sequence}`
    }));

    act(() => result.current.signIn("a.singh"));

    let customer: Customer | undefined;
    act(() => {
      customer = result.current.createCustomer({
        name: "Audit Test Customer",
        risk: "Normal",
        idStatus: "verified"
      });
    });

    const draft: ExchangeDraft = {
      customerId: customer!.id,
      from: "CAD",
      to: "USD",
      inputAmount: 1000,
      feeCad: 4,
      purpose: "Currency exchange",
      sourceOfFunds: "Cash"
    };
    act(() => { result.current.postExchange(draft); });
    act(() => { result.current.postExchange({ ...draft, inputAmount: 0 }); });
    act(() => result.current.signOut());
    act(() => result.current.resetDemo());

    expect(persistence.audit.read(defaultScope).map((event) => event.action)).toEqual([
      "session.sign_in",
      "customer.create",
      "transaction.post",
      "transaction.post_failed",
      "session.sign_out",
      "demo.reset"
    ]);
  });
});
