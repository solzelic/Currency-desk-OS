/* Phone Pricing. The list, the spread sheet, and publish.
   The desktop window is compared to a screenshot taken from the
   shell before this screen, so a phone rule that leaks is a failed
   pixel, not a comment. */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/screenshots";

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

async function openPricing(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="pricing"]').click();
  await dismissTour(page);
  await expect(page.locator(".pr-phone")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  } catch (err) {
    console.error("pricing screenshot skipped", name, err);
  }
}

function ratesGet(url: string, method: string): boolean {
  const path = new URL(url).pathname;
  return method === "GET" && path === "/api/rates";
}

test("desktop pricing is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page, "j.masri");
  await page.locator('#appbar [data-app="pricing"]').click();
  const win = page.locator(".win.show.active");
  await expect(win.locator(".win-title")).toContainText(/Pricing/);
  await expect(win).toHaveCSS("transform", "none");
  await expect(page.locator(".pr-phone")).toHaveCount(0);
  await expect(page.locator(".pr-sheet")).toHaveCount(0);
  const button = win.getByRole("button", { name: "Publish to Rate Board" });
  const height = await button.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThan(40);
  /* The "2m ago" label is a clock. Freeze the words so the picture
     is the layout, not the minute the test happened to run. */
  await win.getByText(/refreshed/).evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent && node.textContent.indexOf("refreshed") >= 0) {
        node.textContent = node.textContent.replace(/refreshed .+/, "refreshed 2m ago");
      }
      node = walker.nextNode();
    }
  });
  await expect(win).toHaveScreenshot("desktop-pricing-1280.png", {
    maxDiffPixels: 0,
    animations: "disabled",
    caret: "hide",
  });
});

for (const width of [360, 390]) {
  test(`pricing list at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='loading']")).toHaveCount(0);
    const phone = page.locator(".pr-phone");
    await expect(phone.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
    await expect(phone).toContainText("Changes save by themselves");
    await expect(phone).toContainText("For every currency");
    await expect(phone).toContainText("Spread by currency");
    await expect(phone).toContainText("USD");
    await expect(phone).toContainText("US dollar");
    await expect(phone).toContainText("0.00 CAD");
    await expect(phone).not.toContainText("Example data");
    await expect(phone).not.toContainText("$");
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    const row = await phone.locator(".phone-row").first().boundingBox();
    expect(row && row.height).toBeGreaterThanOrEqual(44);
    const publish = page.locator(".pr-phone .phone-sticky-btn");
    await expect(publish).toHaveText("Publish to Rate Board");
    const box = await publish.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(48);
    await shot(page, `pricing_list_${width}`);
  });

  test(`stepper preview matches priceDeal at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='list']")).toBeVisible();
    await page.getByRole("button", { name: /USD/ }).click();
    const sheet = page.getByRole("dialog", { name: "US dollar spread" });
    await expect(sheet).toBeVisible();
    const before = await sheet.locator("[data-pr='buy']").innerText();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await expect(sheet.getByRole("button", { name: "Save 1.2% for USD" })).toBeVisible();
    const expected = await page.evaluate(() => {
      const C = window.CDOS;
      const home = C.deskHomeCcy();
      const raw = localStorage.getItem("cdos_settings");
      const settings = raw ? JSON.parse(raw) : {};
      const next = Object.assign({}, settings, {
        spreads: Object.assign({}, settings.spreads || {}, { USD: 1.2 }),
      });
      const mid = C.unitCadMid("USD");
      const known = mid > 0 && Number.isFinite(mid);
      const deal = C.priceDeal({ inCcy: "USD", outCcy: home, inAmt: 500, settings: next });
      const money = (n: number) => C.formatPhoneMoney(n, home) || "—";
      return {
        known,
        buy: known ? C.buyUnitCad("USD", next).toFixed(4) : "—",
        sell: known ? C.sellUnitCad("USD", next).toFixed(4) : "—",
        mid: known ? Number(mid).toFixed(4) : "—",
        gets: known ? money(deal.outAmt) : "—",
        earn: known ? money(deal.marginCad) : "—",
      };
    });
    await expect(sheet.locator("[data-pr='buy']")).toHaveText(expected.buy);
    await expect(sheet.locator("[data-pr='sell']")).toHaveText(expected.sell);
    await expect(sheet.locator("[data-pr='mid']")).toHaveText(expected.mid);
    await expect(sheet.locator("[data-pr='gets']")).toHaveText(expected.gets);
    await expect(sheet.locator("[data-pr='earn']")).toHaveText(expected.earn);
    if (expected.known) expect(expected.buy).not.toBe(before);
    const buy = await sheet.locator("[data-pr='buy']").evaluate((el) => getComputedStyle(el).color);
    const sell = await sheet.locator("[data-pr='sell']").evaluate((el) => getComputedStyle(el).color);
    expect(buy).toBe("rgb(30, 90, 168)");
    expect(sell).toBe("rgb(122, 62, 150)");
    await expect(sheet).toContainText("Nothing changes on the Rate Board until you tap Publish.");
    await shot(page, `pricing_edit_${width}`);
  });

  test(`publish hits the rate board once at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/rates/publish") posts.push(req.url());
    });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='list']")).toBeVisible();
    const button = page.locator(".pr-phone .phone-sticky-btn");
    await expect(button).toBeEnabled();
    const done = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/rates/publish" && res.request().method() === "POST",
    );
    await button.click();
    const res = await done;
    expect(res.status()).toBe(200);
    await expect(page.locator("[data-pr='toast']")).toContainText(/Sent to the Rate Board\./);
    await expect(page.locator("[data-pr='toast']")).toContainText(/\d+ currencies, \d{1,2}:\d{2}/);
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    await page.waitForTimeout(400);
    expect(posts).toHaveLength(1);
    await shot(page, `pricing_published_${width}`);
  });

  test(`pricing shows skeletons while the board loads at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let hold = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/rates**", async (route) => {
      if (hold && ratesGet(route.request().url(), route.request().method())) await gate;
      await route.continue();
    });
    await atDesk(page, "j.masri");
    hold = true;
    await openPricing(page);
    await expect(page.locator("[data-pr='loading']")).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading pricing" })).toBeVisible();
    await expect(page.locator(".pr-phone .phone-sticky-btn")).toBeDisabled();
    await shot(page, `pricing_loading_${width}`);
    release();
  });
}

test("a failed board load keeps the saved spreads", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await page.route("**/api/rates**", async (route) => {
    if (ratesGet(route.request().url(), route.request().method())) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await atDesk(page, "j.masri");
  await openPricing(page);
  await expect(page.getByRole("alert")).toContainText("The Rate Board didn't load.");
  await expect(page.locator("[data-pr='list']")).toContainText("USD");
  await expect(page.locator("[data-pr='list']")).toContainText("Not loaded");
});

test("no foreign currencies is an empty state", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page, "j.masri");
  await page.evaluate(() => {
    window.CDOS.deskCurrencyList = () => ["CAD"];
  });
  await openPricing(page);
  await expect(page.locator("[data-pr='empty']")).toContainText("No currencies yet");
  await expect(page.locator(".pr-phone .phone-sticky")).toHaveCount(0);
});

test("pricing passes the phone sweep", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openPricing(page);
  await expect(page.locator("[data-pr='list']")).toBeVisible();
  await phoneSweep(page, { roots: [".pr-phone", ".phone-head", "#phone-dock"] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /USD/ }).click();
  await expect(page.locator("[data-pr='sheet']")).toBeVisible();
  await phoneSweep(page, { roots: [".pr-sheet"] });
});

test("a teller cannot publish", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/rates/publish") posts.push(req.url());
  });
  await atDesk(page, "m.costa");
  await openPricing(page);
  await expect(page.locator("[data-pr='list']")).toBeVisible();
  const button = page.locator(".pr-phone .phone-sticky-btn");
  await expect(button).toBeDisabled();
  await expect(page.locator(".pr-phone")).toContainText("Only an owner or a manager can publish.");
  await button.click({ force: true });
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);
});
