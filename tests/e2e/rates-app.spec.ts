/* Rates v2.5, the desk side: one Rates app in place of the framed York FX
   Rate Board page. The board is this desk's own server board; Publish goes
   to /api/rates/publish; "What customers see now" is the last publish,
   never the draft. A teller sees the rates and cannot change them. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

async function openRates(page: Page, staffId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, staffId);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await expect(page.locator(".rates-board")).toBeVisible({ timeout: 30_000 });
}

const board = (page: Page) => page.evaluate(async () => (await (await fetch("/api/rates")).json()).board);
const toggle = (page: Page, code: string) => page.getByRole("switch", { name: `${code} on the board` });

test("a manager takes a currency off the board and publishes it, and customers see the publish, not the draft", async ({ page }) => {
  await openRates(page, "r.haddad");
  const tabs = page.locator(".fld-bar", { has: page.getByRole("button", { name: "Pricing & rates" }) }).locator(".fld-tab");
  await expect(tabs).toHaveText(["Board", "Pricing & rates"]);
  /* The board this test found, put back exactly at the end even if the
     test fails: later files price their tills off this seed board, and a
     publish from here carries today's market rates. */
  const found = await board(page);
  try {
    const code = "GBP";
    expect(found.rows[code]?.show).not.toBe(false);
    await toggle(page, code).click();
    await expect(page.getByText("Unpublished changes")).toBeVisible();
    await expect(page.getByText("Your changes aren't live yet.")).toBeVisible();
    const preview = page.getByRole("region", { name: "What customers see now" });
    await expect(preview).toContainText(code);

    await page.getByRole("button", { name: "Publish" }).click();
    await expect(page.getByRole("status")).toHaveText("Published. Your site and window screens show it now.");
    await expect(page.getByText("Live on your site and window")).toBeVisible();
    const after = await board(page);
    expect(after.publicationId).not.toBe(found.publicationId);
    expect(after.rows[code].show).toBe(false);
    expect(after.publishedBy).toBe("r.haddad");
  } finally {
    const restored = await page.evaluate(async (b) => (await fetch("/api/rates/publish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyMargin: b.buyMargin, sellMargin: b.sellMargin, rows: b.rows, ...(b.order ? { order: b.order } : {}) }),
    })).status, found);
    expect(restored, "the board this test found is published again").toBe(200);
  }
});

test("a teller sees today's rates and cannot change or publish them", async ({ page }) => {
  await openRates(page, "m.costa");
  await expect(page.getByText("You can see today's rates. Changing them is for the owner and managers.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  await expect(toggle(page, "USD")).toBeDisabled();
  const refused = await page.evaluate(async () => (await fetch("/api/rates/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyMargin: 0.01, sellMargin: 0.01, rows: { USD: { mid: 1.3 } } }),
  })).status);
  expect(refused).toBe(403);
});

test("shots: the Rates board at 360, 390, 430, 600, 1280 and 1440, light and dark", async ({ page }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  for (const theme of ["light", "dark"] as const) {
    /* Fresh window per theme, widest first: a window shrunk to a phone
       does not grow back when the viewport does. */
    await openRates(page, "r.haddad");
    await page.evaluate((t) => (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(t), theme);
    for (const width of [1440, 1280, 600, 430, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `docs/pr-shots/rates-app/board-${width}-${theme}.png` });
    }
  }
});
