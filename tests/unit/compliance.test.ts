import { describe, expect, it } from "vitest";
import { canPost, runComplianceChecks } from "../../src/domain/compliance";
import { defaultScope } from "../../src/domain/seed";
import type { Customer, ExchangeDraft } from "../../src/domain/types";

const verifiedCustomer: Customer = {
  ...defaultScope,
  id: "c-1",
  name: "Verified Customer",
  risk: "Normal",
  idStatus: "verified"
};

const highRiskCustomer: Customer = {
  ...verifiedCustomer,
  id: "c-2",
  name: "High Risk Customer",
  risk: "High"
};

const baseDraft: ExchangeDraft = {
  customerId: "c-1",
  from: "CAD",
  to: "USD",
  inputAmount: 1000,
  feeCad: 4,
  purpose: "Currency exchange",
  sourceOfFunds: "Cash"
};

const till = { CAD: 25000, USD: 12000, EUR: 7000, GBP: 3500 };

describe("compliance checks", () => {
  it("passes a small exchange for a verified customer", () => {
    const checks = runComplianceChecks(verifiedCustomer, baseDraft, till);

    expect(checks.every((check) => check.status === "pass")).toBe(true);
    expect(canPost(checks)).toBe(true);
  });

  it("blocks when no customer is selected", () => {
    const checks = runComplianceChecks(undefined, { ...baseDraft, customerId: "" }, till);

    expect(checks.find((check) => check.id === "customer")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("blocks ID-required deals when customer is not verified", () => {
    const checks = runComplianceChecks(
      { ...verifiedCustomer, idStatus: "on-file" },
      { ...baseDraft, inputAmount: 3000 },
      till
    );

    expect(checks.find((check) => check.id === "identity")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("warns for high-risk customers without blocking", () => {
    const checks = runComplianceChecks(highRiskCustomer, baseDraft, till);

    expect(checks.find((check) => check.id === "risk")?.status).toBe("warn");
    expect(canPost(checks)).toBe(true);
  });

  it("blocks reportable deals without required capture fields", () => {
    const checks = runComplianceChecks(
      verifiedCustomer,
      {
        ...baseDraft,
        inputAmount: 10000,
        purpose: "",
        sourceOfFunds: ""
      },
      till
    );

    expect(checks.find((check) => check.id === "reportable")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("warns but allows reportable deals with capture fields", () => {
    const checks = runComplianceChecks(verifiedCustomer, { ...baseDraft, inputAmount: 10000 }, till);

    expect(checks.find((check) => check.id === "reportable")?.status).toBe("warn");
    expect(canPost(checks)).toBe(true);
  });

  it("blocks invalid fees and same-currency drafts", () => {
    const checks = runComplianceChecks(
      verifiedCustomer,
      { ...baseDraft, to: "CAD", feeCad: -1 },
      till
    );

    expect(checks.find((check) => check.id === "fee")?.status).toBe("block");
    expect(checks.find((check) => check.id === "currency")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("blocks exchanges when the till cannot fund the output", () => {
    const checks = runComplianceChecks(verifiedCustomer, baseDraft, { ...till, USD: 100 });

    expect(checks.find((check) => check.id === "liquidity")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });
});
