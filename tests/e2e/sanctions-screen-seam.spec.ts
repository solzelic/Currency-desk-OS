/* A Canada desk must not present the sample names as a sanctions screen.

   York opens on the Canada pack. The browser still seeds a beneficiary
   named Lin Wei. On main, that name is fuzzy-matched to the sample
   entry Wei Lin and shown as an OFAC hit, and the dashboard tile
   shows the count. This seam requires the not-connected sentence and
   no count. It does not post a deal.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

test("a Canada desk says sanctions screening is not connected and shows no count", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const packId = await page.evaluate(async () => {
    const answer = await fetch("/api/ledger/jurisdiction").then((response) => response.json());
    return answer.pack && answer.pack.packId;
  });
  expect(packId).toMatch(/^pack-ca-v/);

  await page.locator('[data-app="compliance"]').click();
  const compliance = page.locator(".win.show.active");
  await expect(compliance.getByText("Compliance").first()).toBeVisible();
  const screening = await compliance.innerText();
  expect(screening).toMatch(/Sanctions screening is not connected yet/);
  expect(screening).toMatch(/Check clients against your government's official lists yourself/);
  expect(screening).not.toMatch(/Every client and beneficiary screened against OFAC/i);
  expect(screening).not.toMatch(/Wei Lin/);
  expect(screening).not.toMatch(/Confirmed hit/);
  expect(screening).not.toMatch(/Possible match/);

  const tile = compliance.locator("button").filter({ hasText: "Screening" }).first();
  const tileText = await tile.innerText();
  expect(tileText).toContain("Not connected");
  expect(tileText).not.toMatch(/\d/);
  await expect(compliance.getByTestId("sanctions-screening-tile")).toContainText("Not connected");
  await expect(compliance.getByTestId("sanctions-not-connected")).toContainText("Sanctions screening is not connected yet");

  await page.locator('[data-app="dashboard"]').click();
  const dashboard = page.locator(".win.show.active");
  await expect(dashboard.getByText(/Cash position/i)).toBeVisible();
  const dashTile = dashboard.getByTestId("dashboard-sanctions-tile");
  await expect(dashTile).toContainText("Not connected");
  await expect(dashTile).toContainText("Sanctions");
  expect(await dashTile.innerText()).not.toMatch(/\d/);

  await page.locator('[data-app="settings"]').click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  const settings = page.locator(".win.show.active");
  await expect(settings.getByText(/Reporting & thresholds/i)).toBeVisible();
  const settingsWords = await settings.innerText();
  expect(settingsWords).toMatch(/Sanctions screening is not connected yet/);
  expect(settingsWords).toMatch(/Check clients against your government's official lists yourself/);
  expect(settingsWords).not.toMatch(/OFAC/);
  expect(settingsWords).not.toMatch(/OSFI/);
  await expect(settings.getByTestId("sanctions-screening-gap")).toContainText("Not connected");
});
