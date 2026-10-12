/* The client compliance card is the same static window as the clusters
   and the server gate. 23:50 and 00:10 are not one report. A same-day
   pair is. Reading the rolling lookback would mark the midnight pair
   reportable, and this seam would go red. A missing engine is an
   error, not a quiet zero. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const NIGHT = "Mina Night";
const DAY = "Sam Day";

test("the client card uses the static window and refuses a missing engine", async ({ page }) => {
  test.setTimeout(120_000);
  const half = 5000;
  const row = (id: string, date: string, time: string, customer: string) => ({
    id, ref: id, status: "posted", type: "Currency Exchange",
    inAmt: half, inCcy: "CAD", outAmt: 1, outCcy: "USD",
    date, time, customer, beneficiary: "", capture: {},
  });
  await page.addInitScript(({ rows, clients }) => {
    localStorage.setItem("cdos_rows_v1", JSON.stringify(rows));
    localStorage.setItem("cdos_clients_v1", JSON.stringify(clients));
  }, {
    rows: [
      row("late", "2026-10-11", "23:50", NIGHT),
      row("early", "2026-10-12", "00:10", NIGHT),
      row("am", "2026-10-12", "10:00", DAY),
      row("mid", "2026-10-12", "11:00", DAY),
    ],
    clients: {
      [NIGHT]: { idType: "Passport", idNum: "MN1", idExpiry: "2030-01-01" },
      [DAY]: { idType: "Passport", idNum: "SD1", idExpiry: "2030-01-01" },
    },
  });
  await signInAtDesk(page, "j.masri");
  await page.evaluate(() => window.CDOS.setBranchTimeZone("America/Toronto"));
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();

  await page.getByText(/^Clients · KYC$|^Clients$/).first().click();
  const open = async (name: string) => {
    const card = page.getByRole("button", { name: new RegExp(`${name} INDIVIDUAL`) });
    await card.waitFor({ state: "visible", timeout: 20_000 });
    await card.click();
  };
  const close = async () => {
    const scrim = page.locator("div.fixed.inset-0").last();
    await scrim.click({ position: { x: 8, y: 8 } });
    await scrim.waitFor({ state: "hidden", timeout: 10_000 });
  };

  await open(NIGHT);
  await expect(page.getByTestId("client-reportable-count")).toHaveText("0");
  await expect(page.getByText("Reportable — not yet filed")).toHaveCount(0);
  await close();

  await open(DAY);
  await expect(page.getByTestId("client-reportable-count")).toHaveText("1");
  await expect(page.getByText("Reportable — not yet filed")).toBeVisible();
  await close();

  await page.evaluate(() => { window.CDOS._compliance = undefined; });
  await open(DAY);
  await expect(page.getByTestId("compliance-engine-error")).toBeVisible();
  await expect(page.getByTestId("client-reportable-count")).toHaveCount(0);
  await expect(page.getByText("No open flags")).toHaveCount(0);
  await expect(page.getByText("Reportable — not yet filed")).toHaveCount(0);
});
