import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  addCalendarDays,
  calendarDate,
  chequeFeeAmount,
  ruleFor,
  DEFAULT_CHEQUE_SCHEDULE,
} from "../src/ledger/cheque-money.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, "..");

describe("cheque fee", () => {
  it("rounds a half cent up: 1,000.25 at 2% is 20.01", () => {
    const payroll = ruleFor(DEFAULT_CHEQUE_SCHEDULE, "payroll");
    expect(payroll).toBeTruthy();
    expect(chequeFeeAmount("1000.25", payroll!.feePct, payroll!.feeMin).toFixed(2)).toBe("20.01");
  });

  it("uses the minimum when the percent is smaller", () => {
    const payroll = ruleFor(null, "payroll")!;
    expect(chequeFeeAmount("100.00", payroll.feePct, payroll.feeMin).toFixed(2)).toBe("5.00");
  });

  it("is zero only when the rule is zero", () => {
    expect(chequeFeeAmount("1000.25", "0", "0").toFixed(2)).toBe("0.00");
    expect(chequeFeeAmount("1000.25", "2", "0").eq(new Decimal("20.01"))).toBe(true);
  });

  it("adds hold days on the calendar, including east of UTC", () => {
    expect(addCalendarDays("2026-10-12", 1)).toBe("2026-10-13");
    expect(addCalendarDays("2026-10-12", 0)).toBe("2026-10-12");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(here, "hold-date-tokyo.ts")],
      { cwd: serverRoot, env: { ...process.env, TZ: "Asia/Tokyo" }, encoding: "utf8" },
    );
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(run.stdout).toContain("2026-10-13");
  });

  it("reads a stored DATE as the calendar day, not the UTC instant", () => {
    const localMidnight = new Date(2026, 9, 13);
    expect(calendarDate(localMidnight)).toBe("2026-10-13");
    expect(calendarDate("2026-10-13T00:00:00.000Z")).toBe("2026-10-13");
  });
});
