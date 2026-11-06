/* Sol, 3 Nov 2026: on staging the seed shop shows as Test FX. Live keeps
   York FX.

   The seam server is not a staging host, so, as in staging-banner.spec.ts,
   these tests let the real /api/auth/me answer and change only its
   `staging` flag, which is the flag the desk reads. Without that change the
   answer has the production shape and the names stay York. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const SHOTS = "docs/pr-shots/test-fx";

async function asStaging(page: Page): Promise<void> {
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    return route.fulfill({ response, json: { ...(await response.json()), staging: true } });
  });
}

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 10; i++) {
    if (await skip.isVisible()) { await skip.click(); return; }
    await page.waitForTimeout(150);
  }
}

async function useTheme(page: Page, name: "light" | "dark"): Promise<void> {
  await page.evaluate((theme) => {
    const cdos = (window as unknown as { CDOS?: { theme?: { set: (pref: string) => void } } }).CDOS;
    if (!cdos || !cdos.theme) throw new Error("theme controller missing");
    cdos.theme.set(theme);
  }, name);
  await expect(page.locator("html")).toHaveAttribute("data-cdtheme", name);
}

const shopName = (page: Page, width: number) => page.locator(width <= 430 ? ".phone-shop-name:visible" : ".tenant-name:visible").first();

for (const [width, height] of [[1280, 800], [390, 844]] as const) {
  test(`on staging at ${width}px the header says Test FX`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await asStaging(page);
    await signInAtDesk(page);
    await dismissTour(page);
    await expect(page.locator("#cdos-staging-banner")).toBeVisible({ timeout: 20_000 });
    await expect(shopName(page, width)).toHaveText("Test FX");
  });
}

test("off staging the header keeps York Currency Exchange and the texts sender is untouched", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await dismissTour(page);
  await expect(shopName(page, 1280)).toHaveText("York Currency Exchange");
  expect(await page.evaluate(() => localStorage.getItem("cdos_tg_settings_v1"))).toBeNull();
});

test("on staging the texts sender is TEST FX", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await asStaging(page);
  await signInAtDesk(page);
  await dismissTour(page);
  await expect(shopName(page, 1280)).toHaveText("Test FX");
  await expect.poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem("cdos_tg_settings_v1"))) ?? "{}"))
    .toMatchObject({ desk: "TEST FX", from: "TESTFX" });
});

test("shots: the staging header at 360, 390, 430 and 1280, light and dark", async ({ page }) => {
  test.skip(process.env.TEST_FX_SHOTS !== "1", "set TEST_FX_SHOTS=1 to write the PR shots");
  await page.setViewportSize({ width: 1280, height: 800 });
  await asStaging(page);
  await signInAtDesk(page);
  await dismissTour(page);
  for (const theme of ["light", "dark"] as const) {
    await useTheme(page, theme);
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: width <= 430 ? 844 : 800 });
      await expect(shopName(page, width)).toHaveText("Test FX");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/staging-header-${width}-${theme}.png` });
    }
  }
});
