/* Rates & fees is read-only for a teller before they type.

   m.costa must see grey locked prices, the owner sentence, and no Save.
   A field they can edit would be the bug: they would type, save, and
   only then be refused. j.masri's refused save keeps the number and
   repeats that sentence above Save, with no toast.
   ============================================================ */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The desk under test is the York book.");

const LINE = "Only the owner can change rates and fees. Ask the owner to make this change.";

async function openRates(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
  await page.locator('.app-btn[data-app="settings"]').click();
  await page.locator(".settings-nav button", { hasText: "Rates & fees" }).click();
  await expect(page.locator("[data-rates-panel]")).toBeVisible();
}

test("a teller sees rates and fees read-only", async ({ page }) => {
  await signInAtDesk(page, "m.costa");
  await openRates(page);
  const panel = page.locator("[data-rates-panel]");
  await expect(page.locator("[data-rates-owner-line]")).toHaveText(LINE);
  await expect(panel).toContainText("Two-sided pricing. The desk buys under mid and sells over mid. The gap is your margin.");
  await expect(panel).not.toContainText("\u2014");
  await expect(panel).not.toContainText("\u2013");
  await expect(page.locator('[data-rates-field="defaultSpread"][data-rates-locked]')).toBeVisible();
  await expect(page.locator('[data-rates-field="defaultFee"][data-rates-locked]')).toBeVisible();
  await expect(page.locator("[data-rates-locked] svg").first()).toBeVisible();
  await expect(panel.locator("input")).toHaveCount(0);
  await expect(panel.locator("select")).toHaveCount(0);
  await expect(page.locator("[data-rates-save]")).toHaveCount(0);
  await expect(page.getByText("Only the owner can change this.").first()).toBeVisible();
  await expect(page.getByText("A manager or the owner can change this.")).toBeVisible();
});

test("a manager can change the default spread and not the other prices", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  await openRates(page);
  await expect(page.locator("[data-rates-owner-line]")).toHaveText(LINE);
  await expect(page.locator('[data-rates-field="defaultSpread"] input')).toBeEditable();
  await expect(page.locator('[data-rates-field="defaultFee"][data-rates-locked]')).toBeVisible();
  await expect(page.locator('[data-rates-field="defaultFee"] input')).toHaveCount(0);
  await expect(page.getByText("A manager or the owner can change this.")).toBeVisible();
  await expect(page.locator("[data-rates-save]")).toBeVisible();
});

test("a refused rates save keeps the typed value above Save", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  await openRates(page);
  await expect(page.locator("[data-rates-owner-line]")).toHaveCount(0);
  const fee = page.locator('[data-rates-field="defaultFee"] input');
  await fee.fill("4.25");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cdos-rates-refused")));
  const refusal = page.locator("[data-rates-refusal]");
  await expect(refusal).toHaveText(LINE);
  await expect(fee).toHaveValue("4.25");
  await expect(page.locator("#cdos-persist-banner")).toHaveCount(0);
  const refusalBox = await refusal.boundingBox();
  const saveBox = await page.locator("[data-rates-save]").boundingBox();
  expect(refusalBox && saveBox && refusalBox.y + refusalBox.height <= saveBox.y).toBe(true);
});
