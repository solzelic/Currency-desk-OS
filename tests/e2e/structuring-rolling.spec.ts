/* The structuring watch is N × 24 hours ending at the deal. N of 1
   includes a deal 23 hours earlier on the previous calendar date,
   and leaves out a deal on that date that is more than 24 hours
   earlier. The screen label stays "N-day rolling". */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

test("a 23-hour-old deal on the previous date is inside a 1-day watch", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const answer = await page.evaluate(() => {
    window.CDOS.setBranchTimeZone("Asia/Jerusalem");
    const regime = window.CDOS.getRegime({});
    const line = regime.threshold;
    if (!(line > 0)) throw new Error("The desk has no large-cash line.");
    const half = line / 2;
    const settings = { structuringDays: 1, threshold: line };
    const row = (id: string, date: string, time: string) => ({
      id, ref: id, status: "posted", type: "Currency Exchange",
      inAmt: half, inCcy: "CAD", outAmt: 1, outCcy: "USD",
      date, time, customer: "Ada Conductor", beneficiary: "", capture: {},
    });
    const end = window.CDOS.branchWallTime("2026-10-12", "00:10");
    const start = window.CDOS.structuringWatchStart(1, end);
    const recent = window.CDOS.branchWallTime("2026-10-11", "01:10");
    const early = window.CDOS.branchWallTime("2026-10-11", "00:05");
    const flagsOf = (rows: ReturnType<typeof row>[]) => window.CDOS.computeFlags(rows, {}, settings);
    const close = flagsOf([row("old", "2026-10-11", "01:10"), row("now", "2026-10-12", "00:10")]);
    const far = flagsOf([row("early", "2026-10-11", "00:05"), row("now", "2026-10-12", "00:10")]);
    return {
      line,
      recentDate: window.CDOS.branchCalendarDate(recent),
      recentIn: recent >= start && recent <= end,
      earlyIn: early >= start && early <= end,
      closeStr: [close.old.str, close.now.str],
      farStr: [far.early.str, far.now.str],
    };
  });
  expect(answer.line).toBe(10000);
  expect(answer.recentDate).toBe("2026-10-11");
  expect(answer.recentIn).toBe(true);
  expect(answer.earlyIn).toBe(false);
  expect(answer.closeStr).toEqual([false, true]);
  expect(answer.farStr).toEqual([false, false]);
});
