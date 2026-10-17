/* Rates & fees is read-only for a teller before they type.

   m.costa must see grey locked prices, the teller sentence, and no Save.
   A field they can edit would be the bug: they would type, save, and
   only then be refused. r.haddad's refused save keeps the number and
   repeats the manager sentence above Save, with no toast.
   ============================================================ */
import type { Page, Locator } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The desk under test is the York book.");

const TELLER = "Only the owner can change rates and fees. Ask the owner or a manager.";
const MANAGER = "Only the owner can change most of these. You can change the default spread.";

/** WCAG contrast of the lock pill's text against its own background. */
async function pillContrast(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const parts = (c: string) => c.match(/[\d.]+/g)?.map(Number) ?? [];
    const lum = (r: number, g: number, b: number) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const fg = parts(style.color);
    const bg = parts(style.backgroundColor);
    const a = fg[3] ?? 1;
    const r = fg[0] * a + bg[0] * (1 - a);
    const g = fg[1] * a + bg[1] * (1 - a);
    const b = fg[2] * a + bg[2] * (1 - a);
    const hi = Math.max(lum(r, g, b), lum(bg[0], bg[1], bg[2]));
    const lo = Math.min(lum(r, g, b), lum(bg[0], bg[1], bg[2]));
    return (hi + 0.05) / (lo + 0.05);
  });
}

async function openRates(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
  /* A teller has no Settings icon. Profile, then Rates & fees. */
  const dock = page.locator('.app-btn[data-app="settings"]');
  if (await dock.isVisible()) await dock.click();
  else {
    await page.locator(".mb-acct").locator("visible=true").first().click();
    await page.getByRole("button", { name: "View profile" }).click();
  }
  await page.locator(".settings-nav button", { hasText: "Rates & fees" }).click();
  await expect(page.locator("[data-rates-panel]")).toBeVisible();
}

test("a teller sees rates and fees read-only", async ({ page }) => {
  await signInAtDesk(page, "m.costa");
  await openRates(page);
  const panel = page.locator("[data-rates-panel]");
  await expect(page.locator("[data-rates-owner-line]")).toHaveText(TELLER);
  await expect(panel).toContainText("Two-sided pricing. The desk buys under mid and sells over mid. The gap is your margin.");
  await expect(panel).not.toContainText("\u2014");
  await expect(panel).not.toContainText("\u2013");
  await expect(page.locator('[data-rates-field="defaultSpread"][data-rates-locked]')).toContainText(/\d+\.\d{2}%/);
  await expect(page.locator('[data-rates-field="defaultFee"][data-rates-locked]')).toContainText(/\d+\.\d{2} CAD/);
  expect(await pillContrast(page.locator("[data-rates-locked]").first())).toBeGreaterThanOrEqual(4.5);
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
  await expect(page.locator("[data-rates-owner-line]")).toHaveText(MANAGER);
  await expect(page.locator('[data-rates-field="defaultSpread"] input')).toBeEditable();
  await expect(page.locator('[data-rates-field="defaultFee"][data-rates-locked]')).toContainText(/\d+\.\d{2} CAD/);
  await expect(page.locator('[data-rates-field="defaultFee"] input')).toHaveCount(0);
  await expect(page.getByText("A manager or the owner can change this.")).toBeVisible();
  await expect(page.locator("[data-rates-save]")).toBeVisible();
});

test("a refused rates save keeps the typed value above Save", async ({ page }) => {
  await signInAtDesk(page, "r.haddad");
  await openRates(page);
  await expect(page.locator("[data-rates-owner-line]")).toHaveText(MANAGER);
  const spread = page.locator('[data-rates-field="defaultSpread"] input');
  await spread.fill("2.5");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("cdos-rates-refused")));
  const refusal = page.locator("[data-rates-refusal]");
  await expect(refusal).toHaveText(MANAGER);
  await expect(spread).toHaveValue("2.5");
  await expect(page.locator("#cdos-persist-banner")).toHaveCount(0);
  const refusalBox = await refusal.boundingBox();
  const saveBox = await page.locator("[data-rates-save]").boundingBox();
  expect(refusalBox && saveBox && refusalBox.y + refusalBox.height <= saveBox.y).toBe(true);
});
