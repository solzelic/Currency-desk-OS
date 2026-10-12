/* Phone Rates. At 360 and 390 the cashier gets the list, the
   quote, and a prefilled New transaction. The 1280 Rate Board
   is proved by tests/e2e/desktop-unchanged.spec.ts. This file
   does not keep a second desktop picture. */
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

async function clock12(page: Page, ms: number): Promise<string> {
  return page.evaluate((at) => window.CDOS.formatPhoneTime(new Date(at)), ms);
}

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
    await expect(status).not.toContainText("Example");
    await expect(status).not.toContainText("Last updated");
    await expect(status).not.toContainText("—");
    const statusText = await status.innerText();
    expect(statusText === "Rates may be out of date" || /^Updated .+ · refreshes hourly$/.test(statusText), statusText).toBe(true);
    const dot = await status.locator("i").evaluate((el) => getComputedStyle(el).backgroundColor);
    if (statusText === "Rates may be out of date") expect(dot).toBe("rgb(232, 176, 74)");
    else expect(dot).not.toBe("rgb(232, 176, 74)");

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
    await expect(sheet.getByRole("heading", { name: /Quote US dollar/ })).toBeVisible();
    const amount = sheet.getByLabel("Customer gives");
    await expect(amount).toBeFocused();
    await amount.fill("500");
    const gets = sheet.locator(".phone-quote-gets b");
    await expect(gets).toHaveText(/\d[\d,]*\.\d{2} CAD/);
    const serverRate = await sheet.locator("[data-server-rate]").getAttribute("data-server-rate");
    expect(serverRate).toMatch(/^\d+\.\d+$/);
    await expect(sheet.locator(".phone-quote-kv")).toContainText(`${serverRate} CAD`);
    await expect(sheet.locator(".phone-quote-kv")).toContainText(/0\.00 CAD/);
    await page.screenshot({ path: `${SHOTS}/rates_quote_${width}.png` });
    const quoted = (await gets.innerText()).replace(/\s*CAD\s*$/, "");
    const quoteId = await gets.getAttribute("data-server-quote");

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

    /* Customer gets is the quote this screen asked the server for.
       Posting that quote is the deal, and the book must show the
       same amount. One width is enough: the second would post again. */
    if (width === 390) {
      expect(quoteId).toBeTruthy();
      const posted = await page.evaluate(async (id) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        const ws = window.CDOS.Backend && window.CDOS.Backend.getWorkspace && window.CDOS.Backend.getWorkspace();
        if (ws) headers["x-workspace-id"] = ws;
        const r = await fetch("/api/quotes/" + encodeURIComponent(id) + "/post", {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify({
            idempotencyKey: "phone-rates-" + id,
            purpose: "Personal travel",
            sourceOfFunds: "Employment income",
          }),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      }, quoteId);
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      expect(posted.body.outputAmount).toBe(quoted.replace(/,/g, ""));
      const postedRate = String(posted.body.rate).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
      expect(postedRate).toBe(serverRate);
    }
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
  const line = "Updated " + await clock12(page, fetchedAt) + " · refreshes hourly";
  const status = page.locator("[data-phone-rates-status]");
  await expect(status).toHaveText(line);
  expect(await status.locator("i").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(232, 176, 74)");
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
  await expect(status).toHaveText("Rates may be out of date");
  expect(await status.locator("i").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(232, 176, 74)");
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
  await expect(page.locator("[data-phone-rates-status]")).toHaveText("Rates locked at " + await clock12(page, at));
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
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
    await page.screenshot({ path: `${SHOTS}/rates_error_${width}.png` });
  }
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
  await expect(sheet.locator(".phone-quote-gets b")).toHaveText(/\d[\d,]*\.\d{2}/);
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
  /* The list is priced in the desk currency the screen was given.
     Customer gets is not. It comes from the server quote, and this
     Canada desk will not quote a PHP payout from a browser-only
     home switch. The figure stays absent. */
  await expect(sheet.locator(".phone-quote-note")).toContainText("The server did not quote this amount.");
  await expect(sheet.locator(".phone-quote-gets b")).toHaveText("—");
  await expect(sheet.locator("[data-server-rate]")).toHaveText("—");
});

test("an owner reaches Pricing from Edit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openRates(page);
  await expect(page.locator('[data-phone-rates="ready"]')).toBeVisible();
  await page.locator(".phone-rates-edit").click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Pricing");
});
