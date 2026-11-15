import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const rules = require("../../shared/exchange-v29.js");

describe("exchange v2.9 rules", () => {
  it("requires ID and occupation at CAD 3000.00 and not at 2999.99", () => {
    expect(rules.fxNeedsId("2999.99")).toBe(false);
    expect(rules.fxNeedsId("3000.00")).toBe(true);
    expect(rules.fxNeedsId("3000")).toBe(true);
  });

  it("requires purpose at CAD 10000 on the deal or the window, and never below", () => {
    expect(rules.purposeRequired("9999.99", "9999.99")).toBe(false);
    expect(rules.purposeRequired("10000.00", "10000.00")).toBe(true);
    expect(rules.purposeRequired("5000.00", "10000.00")).toBe(true);
    expect(rules.purposeRequired("100.00", "100.00")).toBe(false);
  });

  it("counts a hold only after cash moves, and labels the other held, not counted", () => {
    expect(rules.holdCounts({ cashMoved: false })).toBe(false);
    expect(rules.holdCounts({ cashMoved: true })).toBe(true);
    expect(rules.holdCounts({ cashMoved: true, superseded: true })).toBe(false);
    expect(rules.holdMeterLabel({ cashMoved: false })).toBe("Held, not counted");
    expect(rules.HOLD_FOOTER).toBe("Holds count once any cash moves.");
    expect(rules.holdMeterLabel({ cashMoved: true })).toBe(null);
  });

  it("caps the review lock at 60 seconds", () => {
    expect(rules.reviewLockSeconds(undefined)).toBe(60);
    expect(rules.reviewLockSeconds(30)).toBe(30);
    expect(rules.reviewLockSeconds(300)).toBe(60);
    expect(rules.reviewLockSeconds(1)).toBe(1);
    expect(rules.reviewLockSeconds("nope")).toBe(60);
  });

  it("treats Client declined as a recorded answer and refuses it for occupation", () => {
    expect(rules.fieldAnswer("", false).ok).toBe(false);
    expect(rules.fieldAnswer("Travel", false)).toMatchObject({ ok: true, declined: false, stored: "Travel" });
    expect(rules.fieldAnswer("Client declined", false)).toMatchObject({ ok: true, declined: true });
    expect(rules.occupationAnswer({ text: "Client declined", allowedCodes: ["employed"] })).toMatchObject({ ok: false, reason: "declined" });
    expect(rules.occupationAnswer({ code: "employed", allowedCodes: ["employed"] })).toMatchObject({ ok: true, code: "employed" });
    expect(rules.occupationAnswer({ text: "Nurse", allowedCodes: ["employed"] })).toMatchObject({ ok: true, text: "Nurse" });
    expect(rules.occupationAnswer({ text: "", code: "", allowedCodes: ["employed"] })).toMatchObject({ ok: false, reason: "missing" });
  });

  it("uses one sentence when this shop has no earlier check", () => {
    const decision = rules.returningDecision({ checkedOn: null, today: "2026-11-15" });
    expect(decision).toEqual({
      offered: false,
      recommended: false,
      reason: "No earlier check at this shop. A new check is needed.",
    });
    const source = readFileSync(new URL("../../shared/exchange-v29.js", import.meta.url), "utf8");
    expect(source.toLowerCase()).not.toContain("another shop");
  });

  it("offers returning client up to 5 years and recommends it from 3", () => {
    expect(rules.returningDecision({ checkedOn: "2024-01-01", today: "2026-11-15" }).offered).toBe(true);
    const soon = rules.returningDecision({ checkedOn: "2023-01-01", today: "2026-11-15" });
    expect(soon.offered).toBe(true);
    expect(soon.recommended).toBe(true);
    expect(rules.returningDecision({ checkedOn: "2020-01-01", today: "2026-11-15" }).reason).toBe(
      "Last ID check over 5 years ago. A new check is needed.",
    );
    expect(rules.returningDecision({ checkedOn: "2024-01-01", today: "2026-11-15", doubt: true }).reason).toBe(
      "Something looks off. Re-check before this deal.",
    );
    expect(rules.returningDecision({ checkedOn: "2024-01-01", today: "2026-11-15", confirmedHigh: true }).reason).toBe(
      "Rated High. A new check is needed.",
    );
  });

  it("stamps a staff screen as Verified, method, age and masks to the last 4", () => {
    const badge = rules.idBadge("2024-11-15", "in person", "2026-11-15");
    expect(badge).toBe("Verified, In person, 2 years");
    expect(rules.idBadge("2025-11-15", "in person", "2026-11-15")).toBe("Verified, In person, 1 year");
    expect(rules.idBadge("2026-11-15", "returning client", "2026-11-15")).toBe("Verified, Returning client, under a year");
    expect(rules.maskIdNumber("PA-4471902")).toBe("...1902");
    expect(rules.riskLabel("high", null)).toBe("Suggested: High");
    expect(rules.riskLabel("high", "medium")).toBe("Medium");
  });

  it("counts CAD notes against customer pays without blocking", () => {
    expect(rules.countReceived({ 100: 2, 50: 1, 20: 0, 10: 0, 5: 0 }, "250.00")).toMatchObject({
      status: "matches",
      label: "Matches",
      difference: "0.00",
    });
    expect(rules.countReceived({ 100: 2 }, "250.00")).toMatchObject({
      status: "short",
      label: "$50.00 short",
    });
    expect(rules.countReceived({ 100: 3 }, "250.00")).toMatchObject({
      status: "over",
      label: "$50.00 over",
    });
    expect(rules.countReceived({ 100: 1, 50: 1, 20: 2, 10: 1, 5: 2 }, "210.00").label).toBe("Matches");
    const counted = new Decimal(100).times(2).plus(new Decimal(50)).minus("250.00");
    expect(counted.toFixed(2)).toBe("0.00");
    expect(new Decimal(100).times(2).minus("250.00").abs().toFixed(2)).toBe("50.00");
    expect(new Decimal(100).times(3).minus("250.00").toFixed(2)).toBe("50.00");
  });

  it("reads the reveal note length from the reason, not a fixed list", () => {
    const other = { active: true, requiresNote: true, minNoteLength: 10 };
    expect(rules.revealNoteOk(other, "too short")).toBe(false);
    expect(rules.revealNoteOk(other, "1234567890")).toBe(true);
    expect(rules.revealNoteOk({ active: true, requiresNote: true, minNoteLength: 12 }, "1234567890")).toBe(false);
    expect(rules.revealNoteOk({ active: true, requiresNote: false, minNoteLength: 0 }, "")).toBe(true);
    expect(rules.revealNoteOk(null, "1234567890")).toBe(false);
  });
});
