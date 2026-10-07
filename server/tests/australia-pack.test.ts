/* Australia, without a database. The dates and the cash test are the
   Act. The rows those rules are stored in are in the Postgres file. */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  addBusinessDays,
  hoursAfter,
  isBusinessDay,
  thresholdTransactionDue,
} from "../src/ledger/australia-rules.js";

describe("an Australian threshold transaction", () => {
  const due = (received: string | null, paid: string | null) =>
    thresholdTransactionDue(
      received === null ? null : new Decimal(received),
      paid === null ? null : new Decimal(paid),
    );

  it("is 10000 AUD or more, received or paid, and not a cent under", () => {
    expect(due("9999.99", "0.00")).toEqual({ received: false, paid: false });
    expect(due("10000.00", "0.00")).toEqual({ received: true, paid: false });
    expect(due("0.00", "10000.00")).toEqual({ received: false, paid: true });
    expect(due("10000.00", "10000.00")).toEqual({ received: true, paid: true });
    expect(due("6000.00", "6000.00")).toEqual({ received: false, paid: false });
  });

  it("does not treat a missing leg as zero cash", () => {
    expect(due(null, null)).toEqual({ received: false, paid: false });
    expect(due(null, "10000.00").received).toBe(false);
    expect(due("10000.00", null).paid).toBe(false);
  });
});

describe("Australian filing clocks", () => {
  it("counts 10 business days after the day, skipping the weekend", () => {
    /* Wednesday 1 July 2026. The tenth business day after that day is
       Wednesday 15 July. The Wednesday itself is not day one. */
    const due = addBusinessDays(new Date("2026-07-01T15:00:00Z"), 10);
    expect(due.toISOString().slice(0, 10)).toBe("2026-07-15");
  });

  it("skips a holiday the caller names, and does not ship a calendar", () => {
    const friday = new Date("2026-07-03T00:00:00Z");
    expect(addBusinessDays(friday, 1).toISOString().slice(0, 10)).toBe("2026-07-06");
    const holidays = new Set(["2026-07-06"]);
    expect(isBusinessDay(new Date("2026-07-06T00:00:00Z"), holidays)).toBe(false);
    expect(addBusinessDays(friday, 1, holidays).toISOString().slice(0, 10)).toBe("2026-07-07");
  });

  it("gives terrorism financing 24 hours on the clock", () => {
    const formed = new Date("2026-07-01T15:04:00Z");
    expect(hoursAfter(formed, 24).toISOString()).toBe("2026-07-02T15:04:00.000Z");
  });
});
