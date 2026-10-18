/* Off-schedule booking is this check, not the posting permission.
   A compliance officer and an auditor are stopped at the posting
   gate before cashing runs, so an HTTP test stays 403 even if this
   function starts saying yes for them. */
import { describe, expect, it } from "vitest";
import { staffRole } from "../src/db/schema.js";
import { canBookOffSchedule } from "../src/ledger/cheques.js";

const OFF_SCHEDULE = new Set(["administrator", "branch_manager"]);

describe("who may book off the cheque schedule", () => {
  it("is true only for the owner and a branch manager", () => {
    expect([...staffRole.enumValues].sort()).toEqual([
      "administrator",
      "auditor",
      "branch_manager",
      "compliance_officer",
      "supervisor",
      "teller",
    ]);
    for (const role of staffRole.enumValues) {
      expect(canBookOffSchedule(role), role).toBe(OFF_SCHEDULE.has(role));
    }
  });
});
