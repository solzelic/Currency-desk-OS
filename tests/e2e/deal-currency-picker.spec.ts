/* The exchange picker offered nine codes compiled into the page.
   The ledger already answers which currencies a dropdown should
   offer. This desk's board is 29, home included, and that list
   has JPY and KRW. */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/deal-currencies";

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function openDeal(page: Page) {
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  const button = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  if (!(await page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-session");
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body.session && body.session.status === "open");
  }))) {
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409;
    });
    expect(opened).toBe(true);
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
  }
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

async function serverList(page: Page): Promise<string[]> {
  await page.waitForFunction(() => {
    const fn = window.CDOS && window.CDOS.deskCurrencyList;
    if (typeof fn !== "function") return false;
    const list = fn();
    return Array.isArray(list) && list.indexOf("JPY") >= 0 && list.indexOf("KRW") >= 0 && list.length === 29;
  });
  return page.evaluate(() => window.CDOS.deskCurrencyList() as string[]);
}

async function openReceiveMenu(page: Page) {
  await page.locator(".cd-money").filter({ has: page.locator(".cd-tx-receive") }).locator("button").click();
}

async function menuCodes(page: Page): Promise<string[]> {
  return page.locator(".cd-ccy-menu [data-ccy]").evaluateAll((els) => els.map((el) => el.getAttribute("data-ccy") || ""));
}

async function showYen(page: Page) {
  const picker = page.locator(".cd-money").filter({ has: page.locator(".cd-tx-receive") }).locator("button");
  if (await page.locator(".cd-ccy-menu").count()) {
    await picker.click();
    await expect(page.locator(".cd-ccy-menu")).toHaveCount(0);
  }
  await openReceiveMenu(page);
  await expect(page.locator(".cd-ccy-menu [data-ccy='JPY']")).toBeAttached();
  await page.evaluate(() => {
    const menu = document.querySelector(".cd-ccy-menu");
    const row = menu && menu.querySelector('[data-ccy="JPY"]');
    if (menu instanceof HTMLElement && row instanceof HTMLElement) menu.scrollTop = Math.max(0, row.offsetTop - 8);
  });
}

test("the deal picker lists the server currencies", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDeal(page);
  const offered = await serverList(page);
  expect(offered).toContain("JPY");
  expect(offered).toContain("KRW");
  expect(offered).not.toContain("KWD");
  expect(offered).toHaveLength(29);

  await openReceiveMenu(page);
  const codes = await menuCodes(page);
  expect(codes.slice().sort()).toEqual(offered.slice().sort());
  expect(codes).toContain("JPY");
  expect(codes).toContain("KRW");

  mkdirSync(SHOTS, { recursive: true });
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    await showYen(page);
    const shot = `${SHOTS}/picker_${width}.png`;
    await page.screenshot({ path: shot });
    await testInfo.attach(`picker-${width}`, { path: shot, contentType: "image/png" });
  }
});
