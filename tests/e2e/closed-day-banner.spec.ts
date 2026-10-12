/* A closed till shows one banner on the ledger. The sentence break is a
   period on the phone and on the desk. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/design-nits";
const BANNER = "The trading day is closed. The book is read-only.";

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  const path = `${SHOTS}/${name}`;
  await page.screenshot({ path });
  if (existsSync("/cursor/stores/self")) {
    mkdirSync("/cursor/stores/self/design-nits", { recursive: true });
    copyFileSync(path, `/cursor/stores/self/design-nits/${name}`);
  }
}

async function openLedger(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const phone = page.locator("#phonebar .phone-tab:visible", { hasText: "Ledger" });
  if (await phone.count()) await phone.click();
  else await page.locator("#appbar").getByText("Ledger", { exact: true }).click();
  await expect(page.getByText(BANNER)).toBeVisible();
  await expect(page.getByText("The trading day is closed — the book is read-only.")).toHaveCount(0);
}

test("the closed ledger says the book is read-only in two sentences", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "a.singh");
  await openLedger(page);
  await shot(page, "banner-1280.png");

  await page.setViewportSize({ width: 390, height: 780 });
  await openLedger(page);
  await shot(page, "banner-390.png");
});
