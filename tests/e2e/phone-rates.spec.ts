/* Phone Rates. At 360 and 390 the cashier gets the list, the
   quote, and a prefilled New transaction. At 1280 the Rate Board
   is the iframe it already was: no phone screen, 14px window,
   not full-bleed. Phone CSS is not allowed to escape the 430px
   query, which is what keeps that desktop a 0-pixel change. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/pr119";

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

async function atDesk(page: Page, staffId = "a.singh"): Promise<void> {
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
  await expect(page.locator("[data-phone-rates]")).toBeVisible();
}

/* A server-backed desk starts shut. Start this deal would open the
   till instead of the ticket, so open it the way a cashier does. */
async function ensureTillOpen(page: Page): Promise<void> {
  const line = page.locator(".phone-till");
  await expect(line).toBeVisible();
  if ((await line.innerText()).includes("Till open")) return;
  await page.locator('#phonebar [data-phone-app="till"]').click();
  await page.getByRole("button", { name: "Open the till" }).click();
  await expect(line).toContainText("Till open");
}

function phoneRatesRulesOutside430(): string[] {
  const bad: string[] = [];
  const walk = (list: CSSRuleList, inPhone: boolean) => {
    for (const rule of list) {
      if (rule.type === CSSRule.MEDIA_RULE) {
        const media = rule as CSSMediaRule;
        walk(media.cssRules, inPhone || /max-width:\s*430px/.test(media.conditionText));
      } else if (!inPhone && rule.cssText && /phone-rates|phone-quote/.test(rule.cssText)) {
        bad.push(rule.cssText.slice(0, 120));
      }
    }
  };
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    walk(rules, false);
  }
  return bad;
}

test("desktop Rates is the Rate Board, unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await page.locator('#appbar [data-app="rates"]').click();
  const win = page.locator(".win.show.active").first();
  await expect(win.locator('iframe[title="Rate Board"]')).toBeVisible();
  await expect(win.locator(".phone-rates")).toHaveCount(0);
  await expect(page.locator(".phone-rates")).toHaveCount(0);
  await expect(win).toHaveCSS("border-radius", "14px");
  await page.screenshot({ path: `${SHOTS}/rates_desktop_1280.png` });
  const box = await win.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThan(1200);
  expect(box!.width).toBeGreaterThan(900);
  expect(await page.evaluate(phoneRatesRulesOutside430)).toEqual([]);
});

for (const width of [360, 390]) {
  test(`cashier rates at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page);
    await ensureTillOpen(page);
    await openRates(page);
    await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
    await expect(page.locator(".phone-rates-edit")).toHaveCount(0);
    await expect(page.locator(".phone-rates-explain")).toContainText("Prices in CAD");
    await expect(page.getByText("Example data")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/rates_teller_${width}.png` });
    const status = page.locator("[data-phone-rates-status]");
    await expect(status).not.toContainText("Live, updated");
    await expect(status).not.toContainText("Example");
    expect(await status.innerText()).toMatch(/Last updated|Rates locked|Rates not updated/);

    const usd = page.locator(".code-USD");
    await expect(usd).toBeVisible();
    await expect(usd.locator(".phone-row-amt")).toHaveText(/^\d+\.\d{4}$/);
    await expect(usd.locator(".phone-row-meta")).toHaveText(/^\d+\.\d{4}$/);
    await expect(usd).not.toContainText("x100");
    const buy = await usd.locator(".phone-row-amt").evaluate((el) => getComputedStyle(el).color);
    const sell = await usd.locator(".phone-row-meta").evaluate((el) => getComputedStyle(el).color);
    expect(buy).toBe("rgb(30, 90, 168)");
    expect(sell).toBe("rgb(122, 62, 150)");
    for (const code of ["INR", "PHP", "MXN", "JPY"]) {
      await expect(page.locator(`.code-${code}`)).toContainText("x100");
    }
    await page.screenshot({ path: `${SHOTS}/rates_list_${width}.png` });

    await page.getByLabel("Find a currency").fill("peso");
    await expect(page.locator(".code-PHP")).toBeVisible();
    await expect(page.locator(".code-MXN")).toBeVisible();
    await expect(page.locator(".code-USD")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/rates_search_${width}.png` });

    await page.getByLabel("Find a currency").fill("");
    await usd.click();
    const sheet = page.locator(".phone-quote");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: /Quote US Dollar/ })).toBeVisible();
    const amount = sheet.getByLabel("Customer gives");
    await expect(amount).toBeFocused();
    await amount.fill("500");
    const gets = sheet.locator(".phone-quote-gets b");
    await expect(gets).toHaveText(/\d[\d,]*\.\d{2} CAD/);
    await expect(sheet.locator(".phone-quote-kv")).toContainText(/\d+\.\d{4} CAD/);
    await expect(sheet.locator(".phone-quote-kv")).toContainText(/0\.00 CAD/);
    await page.screenshot({ path: `${SHOTS}/rates_quote_${width}.png` });
    const quoted = (await gets.innerText()).replace(/\s*CAD\s*$/, "");

    const sells = sheet.getByRole("tab", { name: "Customer sells" });
    expect(await sells.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(22, 21, 19)");
    const start = sheet.getByRole("button", { name: "Start this deal" });
    expect(await start.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(39, 75, 142)");

    await start.click();
    const modal = page.locator(".fixed.inset-0");
    await expect(modal.getByText("New transaction", { exact: true })).toBeVisible();
    await expect(page.getByText("We buy USD")).toBeVisible();
    await expect(page.locator("[data-phone-client]")).toBeFocused();
    await expect(page.locator('.fixed.inset-0 input[inputmode="decimal"]').first()).toHaveValue("500");
    await expect(page.locator(".fixed.inset-0")).toContainText(quoted);
    await page.screenshot({ path: `${SHOTS}/rates_deal_${width}.png` });
  });

  test(`rates loading at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await atDesk(page);
    /* Hold the snapshot until the skeletons are on screen. A short
       delay loses the race to the tour wait, and a cached answer
       never shows loading at all. */
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/rates/market", async (route) => {
      await gate;
      await route.continue();
    });
    await page.locator('#phonebar [data-phone-app="rates"]').click();
    await expect(page.locator('[data-phone-rates="loading"]')).toBeVisible();
    await expect(page.locator(".phone-skel")).toHaveCount(6);
    await expect(page.locator(".phone-rate")).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/rates_loading_${width}.png` });
    release();
    await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
  });
}

test("a fresh provider snapshot is the only Live line", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fetchedAt = Date.now() - 60_000;
  await page.route("**/api/rates/market", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ provider: "open.er-api.com", mids: { USD: 1.36 }, fetchedAt }),
  }));
  await atDesk(page);
  await openRates(page);
  const expected = await page.evaluate((ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }), fetchedAt);
  await expect(page.locator("[data-phone-rates-status]")).toHaveText("Live, updated " + expected);
});

test("a stale snapshot does not say Live", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fetchedAt = Date.now() - 3 * 60 * 60 * 1000;
  await page.route("**/api/rates/market", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ provider: "open.er-api.com", mids: { USD: 1.36 }, fetchedAt }),
  }));
  await atDesk(page);
  await openRates(page);
  const status = page.locator("[data-phone-rates-status]");
  await expect(status).toContainText("Rates not updated since");
  await expect(status).toContainText("Ask the owner.");
  await expect(status).not.toContainText("Live, updated");
});

test("a lock says Rates locked, with its time when we have one", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  const at = Date.now();
  await page.evaluate((ms) => {
    localStorage.setItem("yorkfx_rates_locked", "1");
    localStorage.setItem("yorkfx_rates_locked_at", String(ms));
  }, at);
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await openRates(page);
  const expected = await page.evaluate((ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }), at);
  await expect(page.locator("[data-phone-rates-status]")).toHaveText("Rates locked at " + expected);
});

test("rates that fail to load say so, and do not keep old prices", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  const errors: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  await page.route("**/api/rates/market", (route) => route.abort());
  await openRates(page);
  await expect(page.getByText("Rates did not load. Try again.")).toBeVisible();
  await expect(page.locator(".phone-rate")).toHaveCount(0);
  await expect.poll(() => errors.some((t) => t.includes("Rates did not load"))).toBe(true);
  await page.unroute("**/api/rates/market");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
  await expect(page.locator(".code-USD")).toBeVisible();
});

test("the rate list and the quote pass the phone sweep", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await openRates(page);
  await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
  await expect(page.locator(".code-USD")).toBeVisible();
  await phoneSweep(page, { roots: [".phone-rates"] });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".code-USD").click();
  const sheet = page.locator(".phone-quote");
  await expect(sheet).toBeVisible();
  await sheet.getByLabel("Customer gives").fill("500");
  await phoneSweep(page, { roots: [".phone-quote"] });
});

/* The list is the desk's board, not the market snapshot. A currency
   the board cannot price is left off. Zeroing the pricer is that
   empty board. The published board is not written here: that key is
   saved to the tenant, and this suite shares the desk. */
test("an empty board says so, and passes the phone sweep", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await page.evaluate(() => {
    window.CDOS.buyUnitCad = () => 0;
    window.CDOS.sellUnitCad = () => 0;
  });
  await openRates(page);
  await expect(page.getByText("No rates yet")).toBeVisible();
  await expect(page.getByText("The desk has no currency to quote.")).toBeVisible();
  await expect(page.locator(".phone-rate")).toHaveCount(0);
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await page.screenshot({ path: `${SHOTS}/rates_empty_${width}.png` });
  }
  await phoneSweep(page, { roots: [".phone-rates"] });
});

test("a desk prices the list in its own currency", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await page.evaluate(() => {
    window.CDOS.setDeskPack({ id: "pack-ph-v1", homeCurrency: "PHP", country: "PH" });
  });
  await openRates(page);
  await expect(page.locator(".phone-rates-explain")).toContainText("Prices in PHP");
  const buy = parseFloat(await page.locator(".code-USD .phone-row-amt").innerText());
  expect(buy).toBeGreaterThan(10);
  await page.locator(".code-USD").click();
  const sheet = page.locator(".phone-quote");
  await sheet.getByLabel("Customer gives").fill("500");
  await expect(sheet.locator(".phone-quote-gets b")).toContainText("PHP");
  await expect(sheet.locator(".phone-quote-kv")).toContainText(/\d+\.\d{4} PHP/);
});

test("an owner reaches Pricing from Edit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openRates(page);
  await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
  await page.locator(".phone-rates-edit").click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Pricing");
});
