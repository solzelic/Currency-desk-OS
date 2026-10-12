/* Phone Rates editor. Publish is a later slice. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };

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

async function atDesk(page: Page, staffId: string): Promise<void> {
  await page.setViewportSize(PHONE);
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function openRates(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="rates"]').click();
  await dismissTour(page);
  await expect(page.locator('.phone-rates [data-code="USD"]')).toBeVisible();
}

test("a small unit matches the public board, which prints CAD per 1", async ({ page }) => {
  await atDesk(page, "r.haddad");
  const quote = await page.evaluate(() => {
    const rates = window.CDOS.phoneRates;
    const jpy = 1 / 109.9;
    return rates.boardQuote("JPY", jpy, null, 0.015, 0.015);
  });
  const jpy = 1 / 109.9;
  expect(quote.per).toBe(1);
  expect(quote.label).toBe("JPY");
  expect(quote.buy).toBe((jpy * 0.985).toFixed(5));
  expect(quote.sell).toBe((jpy * 1.015).toFixed(5));
});

test("buy and sell follow the desk formula", async ({ page }) => {
  await atDesk(page, "r.haddad");
  const result = await page.evaluate(() => {
    const rates = window.CDOS.phoneRates;
    return {
      buy: rates.buyPrice(1.3421, null, 0.015),
      sell: rates.sellPrice(1.3421, null, 0.015),
      custom: rates.buyPrice(1.3421, 0.02, 0.015),
      clamped: rates.clampSpot(2, 1.34),
      noFeed: rates.clampSpot(1.5, null),
      name: rates.currencyName("GBP"),
      teller: rates.canChangeRates("teller"),
      manager: rates.canChangeRates("branch_manager"),
    };
  });
  expect(result.buy).toBeCloseTo(1.3421 * 0.985, 6);
  expect(result.sell).toBeCloseTo(1.3421 * 1.015, 6);
  expect(result.custom).toBeCloseTo(1.3421 * 0.98, 6);
  expect(result.clamped.clamped).toBe(true);
  expect(result.noFeed.hasFeed).toBe(false);
  expect(result.name).toBe("British Pound");
  expect(result.teller).toBe(false);
  expect(result.manager).toBe(true);
});

test("a manager edits the board the server published", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  await expect(screen).toHaveAttribute("data-can-publish", "yes");
  await expect(screen.getByText("Buy margin, under spot")).toBeVisible();
  await expect(screen.getByRole("button", { name: "Lock rates in this browser" })).toBeVisible();
  await expect(screen.getByText("On your homepage, top 6")).toBeVisible();
  await expect(screen.locator('[data-code="USD"]')).toContainText("US Dollar");
  await expect(screen.getByRole("button", { name: "Public preview" })).toBeVisible();
  await expect(screen.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  const before = await screen.locator('[data-code="USD"] .is-buy').innerText();
  await screen.getByRole("button", { name: "Raise Buy margin, under spot" }).click();
  await expect(screen.getByText("1.55%")).toBeVisible();
  await expect(screen.locator('[data-code="USD"] .is-buy')).not.toHaveText(before);
  await phoneSweep(page, { roots: [".phone-rates", ".phone-head", "#phone-dock"] });
});

test("a hand-set spot stays within 2% of the feed", async ({ page }) => {
  await page.route(/\/api\/rates\/market$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ provider: "test", mids: { USD: 1.34 }, fetchedAt: Date.now() }),
    });
  });
  await atDesk(page, "r.haddad");
  await openRates(page);
  await page.locator('.phone-rates [data-code="USD"] .phone-rate-main').click();
  const spot = page.getByLabel("Spot for USD");
  await spot.fill("2");
  await spot.blur();
  await expect(spot).toHaveValue("1.3668");
  await expect(page.locator(".phone-rate-pin")).toHaveText("Set by hand");
  await page.getByRole("button", { name: "Use feed spot" }).click();
  await expect(spot).toHaveValue("1.3400");
});

test("a teller sees stacked prices and cannot edit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await atDesk(page, "m.costa");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  await expect(screen).toHaveAttribute("data-can-publish", "no");
  await expect(screen).toContainText("Ask a manager to change rates");
  await expect(screen.locator(".phone-rate-grip")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  const jpy = screen.locator('[data-code="JPY"]');
  await jpy.scrollIntoViewIfNeeded();
  await expect(jpy).toContainText("Japanese Yen");
  await expect(jpy).not.toContainText("x100");
  const stacked = await screen.locator('[data-code="USD"]').evaluate((row) => {
    const buy = row.querySelector(".is-buy").getBoundingClientRect();
    const sell = row.querySelector(".is-sell").getBoundingClientRect();
    return sell.top >= buy.bottom - 1;
  });
  expect(stacked).toBe(true);
  await phoneSweep(page, { roots: [".phone-rates", ".phone-head", "#phone-dock"] });
});

test("a missed board is an error, not an invented list", async ({ page }) => {
  await page.route(/\/api\/rates$/, async (route) => {
    if (route.request().method() === "GET") await route.abort();
    else await route.continue();
  });
  await atDesk(page, "r.haddad");
  await page.locator('#phonebar [data-phone-app="rates"]').click();
  await dismissTour(page);
  const screen = page.locator(".phone-rates");
  await expect(screen).toContainText("Could not reach the server");
  await expect(screen.locator("[data-code]")).toHaveCount(0);
});

test("spread finds Rates", async ({ page }) => {
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.getByRole("textbox", { name: "Search apps" }).fill("spread");
  const names = await page.locator("#phone-more .phone-more-name").allTextContents();
  expect(names).toContain("Rates");
  expect(names).toContain("Pricing");
});
