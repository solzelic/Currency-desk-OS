import { describe, expect, it } from "vitest";
import { runComplianceChecks } from "../../src/domain/compliance";
import { staff } from "../../src/domain/seed";
import { applyTransactionToTill, createReceipt, postExchangeTransaction } from "../../src/domain/transactions";
import type { Customer, ExchangeDraft } from "../../src/domain/types";

const customer: Customer = {
  id: "c-1",
  name: "Verified Customer",
  risk: "Normal",
  idStatus: "verified"
};

const draft: ExchangeDraft = {
  customerId: customer.id,
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash"
};

describe("transaction posting", () => {
  it("posts exchange transactions with stable ledger fields", () => {
    const tx = postExchangeTransaction({
      draft,
      customer,
      teller: staff[0],
      compliance: runComplianceChecks(customer, draft),
      sequence: 1,
      now: new Date("2026-07-11T12:00:00.000Z")
    });

    expect(tx.ref).toBe("CD-260711-001");
    expect(tx.customerId).toBe(customer.id);
    expect(tx.outputAmount).toBe(724.42);
    expect(tx.profitCad).toBe(13);
    expect(tx.compliance).toHaveLength(5);
  });

  it("updates till balances from posted transactions", () => {
    const tx = postExchangeTransaction({
      draft,
      customer,
      teller: staff[0],
      compliance: runComplianceChecks(customer, draft),
      sequence: 1,
      now: new Date("2026-07-11T12:00:00.000Z")
    });

    const till = applyTransactionToTill({ CAD: 25000, USD: 12000 }, tx);

    expect(till.CAD).toBe(26000);
    expect(till.USD).toBe(11275.58);
  });

  it("creates receipts from posted transactions", () => {
    const tx = postExchangeTransaction({
      draft,
      customer,
      teller: staff[0],
      compliance: runComplianceChecks(customer, draft),
      sequence: 1,
      now: new Date("2026-07-11T12:00:00.000Z")
    });

    const receipt = createReceipt(tx, customer, staff[0]);

    expect(receipt.transactionId).toBe(tx.id);
    expect(receipt.lines).toContain("Receipt CD-260711-001");
    expect(receipt.lines.join("\n")).toContain("Customer: Verified Customer");
    expect(receipt.lines.join("\n")).toContain("Received: US$724.42");
  });
});
