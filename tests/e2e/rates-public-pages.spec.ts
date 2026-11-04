/* Rates v2.5, the public pages a shop's customers see: the rate page at
   /r/<address> and a window screen at /s/<token>. The owner opens the page
   and makes a screen through the desk endpoints; a stranger with no
   session then reads them. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });
const SLUG = "e2e-rate-page";
let token = "";
let screenId = "";

async function asOwner(page: Page): Promise<void> {
  await signInAtDesk(page, "j.masri");
}
const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(u as string, b ? { method: m as string, headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : { method: m as string });
  return { status: res.status, body: await res.json() };
}, [method, url, body] as const);

test("the owner opens the rate page and a stranger sees the shop's published rates and a working converter", async ({ page, browser }) => {
  await asOwner(page);
  expect((await api(page, "PUT", "/api/rate-page", { slug: SLUG, live: true })).status).toBe(200);
  const made = await api(page, "POST", "/api/window-screens", { name: "Front window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true });
  expect(made.status).toBe(201);
  token = made.body.token; screenId = made.body.id;
  const published = (await api(page, "GET", `/api/public/rate-pages/${SLUG}`)).body;
  const usd = published.rates.find((r: { code: string }) => r.code === "USD");

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/r/${SLUG}`);
  await expect(stranger.locator("#hero")).toHaveText(published.shop.name);
  await expect(stranger.locator("#rates tr")).toHaveCount(published.rates.length);
  await expect(stranger.locator("#rates tr").first().locator("td").first()).toHaveText(published.rates[0].code);
  await stranger.locator("#calc-code").selectOption("USD");
  await stranger.locator("#calc-amount").fill("500");
  const expected = (500 * usd.buy).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + published.shop.home;
  await expect(stranger.locator("#calc-result")).toHaveText(expected);
  await stranger.close();
});

test("an address that is not live says so", async ({ page }) => {
  await page.goto("/r/no-such-shop-here");
  await expect(page.getByText("This rate page is not available.")).toBeVisible();
});

test("the window screen shows the top six in two columns, dark, and goes blank when retired", async ({ page, browser }) => {
  const tv = await (await browser.newContext()).newPage();
  await tv.setViewportSize({ width: 1440, height: 810 });
  await tv.goto(`/s/${token}`);
  await expect(tv.locator(".rate")).toHaveCount(6);
  await expect(tv.locator("body")).toHaveClass("dark");
  await expect(tv.locator(".grid.two")).toBeVisible();
  await asOwner(page);
  expect((await api(page, "POST", `/api/window-screens/${screenId}/retire`)).status).toBe(200);
  await tv.close();
  /* The answer may sit in a browser's cache for up to 30 seconds
     (max-age=30); the screen asks every minute. A fresh browser is what
     the next poll sees. */
  const later = await (await browser.newContext()).newPage();
  await later.goto(`/s/${token}`);
  await expect(later.getByText("This screen link is not active. Ask the shop for a new one.")).toBeVisible();
  await expect(later.locator(".rate")).toHaveCount(0);
  await later.close();
});

test("shots: the rate page at six widths, and a window screen", async ({ page, browser }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  await asOwner(page);
  await api(page, "PUT", "/api/rate-page", { slug: SLUG, live: true });
  const stranger = await (await browser.newContext()).newPage();
  for (const width of [1440, 1280, 600, 430, 390, 360]) {
    await stranger.setViewportSize({ width, height: 900 });
    await stranger.goto(`/r/${SLUG}`);
    await expect(stranger.locator("#rates tr").first()).toBeVisible();
    await stranger.screenshot({ path: `docs/pr-shots/rates-public/rate-page-${width}.png`, fullPage: width <= 600 });
  }
  for (const theme of ["dark", "light"] as const) {
    const screen = await api(page, "POST", "/api/window-screens", { name: "Shot", kind: "tv", layout: "two", theme, currencies: [], showHours: true });
    await stranger.setViewportSize({ width: 1440, height: 810 });
    await stranger.goto(`/s/${screen.body.token}`);
    await expect(stranger.locator(".rate").first()).toBeVisible();
    await stranger.screenshot({ path: `docs/pr-shots/rates-public/window-screen-${theme}.png` });
    await api(page, "POST", `/api/window-screens/${screen.body.id}/retire`);
  }
  await stranger.close();
});
