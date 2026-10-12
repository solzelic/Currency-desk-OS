/* The 24-hour anchor control shows "Branch midnight" and cannot move
   the window. A stored start of 09:00 is left in place and is not
   applied: 23:50 and 00:10 stay in two windows, and a same-day pair
   still shares one. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

test("the 24-hour anchor control cannot move the window", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const storedBefore = await page.evaluate(() => localStorage.getItem("cdos_settings"));

  await page.getByText(/^Settings$/i).first().click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();

  const anchor = page.getByTestId("agg-window-anchor");
  await expect(anchor).toHaveText("Branch midnight");
  await expect(anchor.locator("xpath=..").locator("input, select")).toHaveCount(0);

  const storedAfter = await page.evaluate(() => localStorage.getItem("cdos_settings"));
  expect(storedAfter).toBe(storedBefore);

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
    const ids = (rows: ReturnType<typeof row>[]) => {
      const clusters = window.CDOS._compliance.aggClusters(rows, regime, settings);
      const first = clusters[0];
      return {
        n: clusters.length,
        txs: (first ? first.txs.map((t: { id: string }) => t.id) : []).slice().sort(),
      };
    };
    return { line, split: ids(split), day: ids(together) };
  });

  expect(answer.line).toBe(10000);
  expect(answer.split.n).toBe(0);
  expect(answer.split.txs).toEqual([]);
  expect(answer.day.n).toBe(1);
  expect(answer.day.txs).toEqual(["am", "mid"]);
});
