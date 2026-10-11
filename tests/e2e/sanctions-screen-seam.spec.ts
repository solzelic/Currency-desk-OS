/* A Canada desk must not present the sample names as a sanctions screen.

   York opens on the Canada pack. The browser still seeds a beneficiary
   named Lin Wei. On main, that name is fuzzy-matched to the sample
   entry Wei Lin and shown as an OFAC hit, and the dashboard tile
   shows the count. This seam requires the not-connected sentence and
   no count. It does not post a deal.
   ============================================================ */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import { bannedNameHits } from "../../scripts/check-sanctions-phrases.mjs";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

/** The compliance window must say screening is not connected, and nothing else about a list. */
function expectHonestScreening(text: string) {
  expect(text).toMatch(/Sanctions screening is not connected yet/);
  expect(text).toMatch(/Check clients against your government's official lists yourself/);
  expect(text).not.toMatch(/Every client and beneficiary screened against/i);
  expect(bannedNameHits(text)).toEqual([]);
  expect(text).not.toMatch(/Lin Wei/);
  expect(text).not.toMatch(/Brooke Lawson/);
  expect(text).not.toMatch(/Maria Carter/);
  expect(text).not.toMatch(/Rohan Miller/);
  expect(text).not.toMatch(/TR-260617-019/);
  expect(text).not.toMatch(/Confirmed hit/);
  expect(text).not.toMatch(/Possible match/);
  expect(text).not.toMatch(/Sanctions hits/i);
  expect(text).not.toMatch(/\b\d+\s+hits?\b/i);
}

async function plantSampleBook(page: Page) {
  await page.evaluate(() => {
    const sample = window.CDOS._transfers.defaultTransfers().find((t) => t.id === "t3");
    localStorage.setItem("cdos_transfers_v1", JSON.stringify(window.CDOS._transfers.defaultTransfers()));
    localStorage.setItem("cdos_beneficiaries_v1", JSON.stringify(window.CDOS._transfers.defaultBeneficiaries()));
    if (!sample) throw new Error("sample wire t3 missing");
  });
}

test("a Canada desk says sanctions screening is not connected and shows no count", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  /* The Transfers desk keeps a sample pipeline in the same browser store
     compliance reads. Plant it the way opening Transfers would, and the
     compliance surfaces must not file it or name it. */
  await plantSampleBook(page);
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const packId = await page.evaluate(async () => {
    const answer = await fetch("/api/ledger/jurisdiction").then((response) => response.json());
    return answer.pack && answer.pack.packId;
  });
  expect(packId).toMatch(/^pack-ca-v/);

  await page.locator('[data-app="compliance"]').click();
  const compliance = page.locator(".win.show.active");
  await expect(compliance.getByText("Compliance").first()).toBeVisible();
  expectHonestScreening(await compliance.innerText());

  const tile = compliance.locator("button").filter({ hasText: "Screening" }).first();
  const tileText = await tile.innerText();
  expect(tileText).toContain("Not connected");
  expect(tileText).not.toMatch(/\d/);
  await expect(compliance.getByTestId("sanctions-screening-tile")).toContainText("Not connected");
  await expect(compliance.getByTestId("sanctions-not-connected")).toContainText("Sanctions screening is not connected yet");

  await compliance.locator(".fld-tab", { hasText: "Filings" }).click();
  await expect(compliance.getByText("Brooke Lawson")).toHaveCount(0);
  await expect(compliance.getByText("Lin Wei")).toHaveCount(0);
  await expect(compliance.getByText("TR-260617-019")).toHaveCount(0);

  await page.locator('[data-app="dashboard"]').click();
  const dashboard = page.locator(".win.show.active");
  await expect(dashboard.getByText(/Cash position/i)).toBeVisible();
  const dashTile = dashboard.getByTestId("dashboard-sanctions-tile");
  await expect(dashTile).toContainText("Not connected");
  await expect(dashTile).toContainText("Sanctions");
  expect(await dashTile.innerText()).not.toMatch(/\d/);
  const wireTile = dashboard.locator("button").filter({ hasText: /to file/ }).first();
  const wireLines = (await wireTile.innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
  expect(wireLines[0]).toBe("0");
  expect(await dashboard.innerText()).not.toMatch(/Brooke Lawson|Lin Wei|TR-260617-019/);

  await page.locator('[data-app="settings"]').click();
  await page
    .locator('div[style*="width: 212px"]')
    .getByText(/Compliance & jurisdiction/i)
    .first()
    .click();
  const settings = page.locator(".win.show.active");
  await expect(settings.getByText(/Reporting & thresholds/i)).toBeVisible();
  expectHonestScreening(await settings.innerText());
  await expect(settings.getByTestId("sanctions-screening-gap")).toContainText("Not connected");

  await page.locator('[data-app="clients"]').click();
  const clients = page.locator(".win.show.active");
  await clients.getByRole("button", { name: "New contact" }).click();
  await page.getByRole("button", { name: "Skip — add ID later" }).click();
  await page.getByPlaceholder("Jane Doe").fill("Ada Chen");
  await page.getByText("Save without verifying").click();
  const file = page.getByTestId("client-identity");
  await expect(file).toBeVisible();
  await expect(file.getByTestId("persona-not-connected")).toHaveText("Persona is not connected yet.");
  await expect(file.getByText(/Background & ID checks via/i)).toHaveCount(0);
  await expect(file.getByText(/screened against/i)).toHaveCount(0);
  await expect(file.getByText(/Verify identity/i)).toHaveCount(0);
  const fileWords = await file.innerText();
  expect(bannedNameHits(fileWords)).toEqual([]);
  expect(fileWords).not.toMatch(/Sanctions hits/);
});

test("a teller sees the same not-connected screening state", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  await plantSampleBook(page);
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  const role = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me").then((response) => response.json());
    return me.user && me.user.role;
  });
  expect(role).toBe("teller");

  await page.locator('[data-app="compliance"]').click();
  const compliance = page.locator(".win.show.active");
  await expect(compliance.getByText("Compliance").first()).toBeVisible();
  await compliance.locator(".fld-tab", { hasText: "Screening" }).click();
  expectHonestScreening(await compliance.innerText());

  const tile = compliance.getByTestId("sanctions-screening-tile");
  await expect(tile).toContainText("Not connected");
  await expect(tile).toContainText("No list loaded");
  expect(await tile.innerText()).not.toMatch(/\d/);
  await expect(compliance.getByTestId("sanctions-not-connected")).toContainText("Sanctions screening is not connected yet");

  await compliance.locator(".fld-tab", { hasText: "Filings" }).click();
  const filings = await compliance.innerText();
  expect(filings).not.toMatch(/Wei Lin|Lin Wei|Brooke Lawson|Maria Carter|Rohan Miller|TR-260617-019|Sanctions hits/i);
  expect(bannedNameHits(filings)).toEqual([]);
});
