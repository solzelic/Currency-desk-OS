import { describe, expect, it } from "vitest";
import { canPost, runComplianceChecks } from "../../src/domain/compliance";
import type { Customer, ExchangeDraft } from "../../src/domain/types";

const verifiedCustomer: Customer = {
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

describe("compliance checks", () => {
  it("passes a small exchange for a verified customer", () => {
    const checks = runComplianceChecks(verifiedCustomer, baseDraft);

    expect(checks.every((check) => check.status === "pass")).toBe(true);
    expect(canPost(checks)).toBe(true);
  });

  it("blocks when no customer is selected", () => {
    const checks = runComplianceChecks(undefined, { ...baseDraft, customerId: "" });

    expect(checks.find((check) => check.id === "customer")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("blocks ID-required deals when customer is not verified", () => {
    const checks = runComplianceChecks({ ...verifiedCustomer, idStatus: "on-file" }, { ...baseDraft, inputAmount: 3000 });

    expect(checks.find((check) => check.id === "identity")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("warns for high-risk customers without blocking", () => {
    const checks = runComplianceChecks(highRiskCustomer, baseDraft);

    expect(checks.find((check) => check.id === "risk")?.status).toBe("warn");
    expect(canPost(checks)).toBe(true);
  });

  it("blocks reportable deals without required capture fields", () => {
    const checks = runComplianceChecks(verifiedCustomer, {
      ...baseDraft,
      inputAmount: 10000,
      purpose: "",
      sourceOfFunds: ""
    });

    expect(checks.find((check) => check.id === "reportable")?.status).toBe("block");
    expect(canPost(checks)).toBe(false);
  });

  it("warns but allows reportable deals with capture fields", () => {
    const checks = runComplianceChecks(verifiedCustomer, { ...baseDraft, inputAmount: 10000 });

    expect(checks.find((check) => check.id === "reportable")?.status).toBe("warn");
    expect(canPost(checks)).toBe(true);
  });
});
