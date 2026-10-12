/* The ledger flag, the compliance cluster, and the wording of an LCTR
   all use branch midnight plus 24 hours. Two cash deals of half the
   line at 23:50 and 00:10 are one rolling lookback and two static
   windows. A stored 09:00 anchor must not pull them back together. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

test("23:50 and 00:10 agree on the static LCTR window", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const answer = await page.evaluate(() => {
    window.CDOS.setBranchTimeZone("America/Toronto");
    const regime = window.CDOS.getRegime({});
    const line = regime.threshold;
    if (!(line > 0)) throw new Error("The desk has no large-cash line.");
    const half = line / 2;
    const settings = { aggWindowStart: "09:00", structuringDays: 7, threshold: line };
    const row = (id: string, date: string, time: string) => ({
      id, ref: id, status: "posted", type: "Currency Exchange",
      inAmt: half, inCcy: "CAD", outAmt: 1, outCcy: "USD",
      date, time, customer: "Ada Conductor", beneficiary: "", capture: {},
    });
    const split = [row("late", "2026-10-11", "23:50"), row("early", "2026-10-12", "00:10")];
    const together = [row("am", "2026-10-12", "10:00"), row("mid", "2026-10-12", "11:00")];
    const dstIn = [row("dstAm", "2026-11-01", "10:00"), row("dstEve", "2026-11-01", "22:00")];
    const dstOut = [row("dstEve", "2026-11-01", "22:00"), row("dstGap", "2026-11-01", "23:30")];
    const flagsOf = (rows: ReturnType<typeof row>[]) => window.CDOS.computeFlags(rows, {}, settings);
    const clustersOf = (rows: ReturnType<typeof row>[]) => window.CDOS._compliance.aggClusters(rows, regime, settings);
    const splitFlags = flagsOf(split);
    const splitClusters = clustersOf(split);
    const dayFlags = flagsOf(together);
    const dayClusters = clustersOf(together);
    const dstInFlags = flagsOf(dstIn);
    const dstOutFlags = flagsOf(dstOut);
    return {
      line,
      splitAgg: [splitFlags.late.agg24, splitFlags.early.agg24],
      splitRolling: [splitFlags.late.rolling24Structuring, splitFlags.early.rolling24Structuring],
      splitAlerts: window.CDOS.computeAlerts(split, splitFlags).rpt,
      splitClusters: splitClusters.length,
      dayAgg: [dayFlags.am.agg24, dayFlags.mid.agg24],
      dayClusterIds: (dayClusters[0] ? dayClusters[0].txs.map((t: { id: string }) => t.id) : []).slice().sort(),
      dayAlerts: window.CDOS.computeAlerts(together, dayFlags).rpt,
      dstInAgg: [dstInFlags.dstAm.agg24, dstInFlags.dstEve.agg24],
      dstInClusters: clustersOf(dstIn).length,
      dstOutAgg: [dstOutFlags.dstEve.agg24, dstOutFlags.dstGap.agg24],
      dstOutClusters: clustersOf(dstOut).length,
    };
  });
  expect(answer.line).toBe(10000);
  expect(answer.splitAgg).toEqual([false, false]);
  expect(answer.splitRolling).toEqual([false, true]);
  expect(answer.splitAlerts).toBe(0);
  expect(answer.splitClusters).toBe(0);
  expect(answer.dayAgg).toEqual([false, true]);
  expect(answer.dayClusterIds).toEqual(["am", "mid"]);
  expect(answer.dayAlerts).toBe(1);
  expect(answer.dstInAgg).toEqual([false, true]);
  expect(answer.dstInClusters).toBe(1);
  expect(answer.dstOutAgg).toEqual([false, false]);
  expect(answer.dstOutClusters).toBe(0);
});
