/* The remaining More apps on a phone. Calculator and Tagged deals
   are the long-tail screen. Dashboard, Loan calculator, and Store
   say to open them on a computer. At 1280 the desktop is unchanged. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const shotDir = process.env.LONGTAIL_SHOTS || "";
const WIDTHS = [360, 390] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await settled(page);
}

async function openMore(page: Page, id: string): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await expect(page.locator("#phone-more")).toBeVisible();
  await page.locator(`#phone-more [data-phone-app="${id}"]`).click();
  await dismissTour(page);
  await settled(page);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotDir) return;
  await page.screenshot({ path: `${shotDir}/${name}.png` });
}

test("desktop calculator is not the phone screen at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await page.locator('#appbar [data-app="calc"]').click();
  await settled(page);
  const win = page.locator(".win.show.active");
  await expect(win.locator(".longtail")).toHaveCount(0);
  await expect(win.getByRole("button", { name: "FX" })).toBeVisible();
});

test("every remaining more app is a phone screen at 360 and 390", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);

  await openMore(page, "calc");
  const calc = page.locator('.longtail[data-app="calc"]');
  await expect(calc.getByRole("heading", { name: "Calculator" })).toBeVisible();
  await expect(calc.getByRole("tab", { name: "Add up" })).toBeVisible();
  await expect(calc.getByRole("button", { name: "Use in a new deal" })).toHaveCount(0);
  await calc.getByRole("tab", { name: "Convert" }).click();
  await expect(calc.getByRole("button", { name: "Use in a new deal" })).toBeVisible();
  await expect(calc.locator(".phone-stat-value")).toContainText(/[A-Z]{3}|No rate yet/);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await shot(page, `longtail_calc_${width}`);
  }
  await phoneSweep(page, { roots: ['.longtail[data-app="calc"]'] });

  await openMore(page, "tagged");
  const tagged = page.locator('.longtail[data-app="tagged"]');
  await expect(tagged.getByRole("heading", { name: "Tagged deals" })).toBeVisible();
  await expect(tagged.getByRole("tab", { name: /Open/ })).toBeVisible();
  await expect(tagged.getByText("No tagged deals.")).toBeVisible();
  await expect(tagged.getByText("No tagged transactions yet")).toHaveCount(0);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await shot(page, `longtail_tagged_${width}`);
  }
  await phoneSweep(page, { roots: ['.longtail[data-app="tagged"]'] });

  const computers: Array<[string, string, string]> = [
    ["dashboard", "Full dashboard is on a computer.", "See today in Reports"],
    ["loan", "The payment schedule is on a computer.", ""],
    ["store", "Adding and removing apps is on a computer.", ""],
  ];
  for (const [id, sentence, action] of computers) {
    await openMore(page, id);
    const screen = page.locator(`.longtail[data-app="${id}"]`);
    await expect(screen.getByRole("heading", { name: "Open this on a computer" })).toBeVisible();
    await expect(screen.getByText(sentence)).toBeVisible();
    await expect(screen.getByRole("button", { name: "More" })).toBeVisible();
    if (action) await expect(screen.getByRole("button", { name: action })).toBeVisible();
    else await expect(screen.locator(".phone-sticky")).toHaveCount(0);
    await expect(page.locator(".ln-wrap, .st-wrap")).toHaveCount(0);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
      await shot(page, `longtail_${id}_${width}`);
    }
    await phoneSweep(page, { roots: [`.longtail[data-app="${id}"]`] });
    if (action) {
      await screen.getByRole("button", { name: action }).click();
      const reports = page.locator('.win.show.active[data-app="reports"]');
      await expect(reports).toBeVisible();
      // The launcher lists Period Summary. "Today" appears only after Generate.
      await expect(reports).toContainText("Period Summary");
    }
  }
});
