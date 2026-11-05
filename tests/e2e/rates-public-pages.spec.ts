/* Rates v2.5, the public pages a shop's customers see, in the design's
   look: the rate page at /r/<address> and a window screen at /s/<token>.
   The owner opens the page and makes a screen through the desk endpoints;
   a stranger with no session then reads them. */
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
/* The page's own money format: two places, grouped from 1,000. */
const money = (page: Page, value: number, code: string) => page.evaluate(([v, c]) => {
  const n = Math.abs(v as number) >= 1000 ? (v as number).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : (v as number).toFixed(2);
  return n + " " + c;
}, [value, code] as const);
/* The page's own English name for a currency, from the browser's Intl. */
const nameOf = (page: Page, code: string) => page.evaluate((c) => new Intl.DisplayNames(["en"], { type: "currency" }).of(c) ?? c, code);
/* Codes with one of the design's flag images (shared/currency-face.js). */
const IMAGED = ["AED", "AUD", "BRL", "CAD", "CHF", "CNY", "EUR", "GBP", "HKD", "IDR", "INR", "JPY", "KRW", "MXN", "MYR", "NGN", "NZD", "PHP", "PKR", "QAR", "SAR", "SEK", "SGD", "THB", "TRY", "USD", "VND", "ZAR"];
const flagImage = (page: Page, code: string) =>
  page.locator(`[data-code="${code}"] [data-flag="${code}"]`).first().evaluate((el) => getComputedStyle(el).backgroundImage);

test("the owner opens the rate page and a stranger sees the published rates with flags and names, and a working converter", async ({ page, browser }) => {
  await asOwner(page);
  expect((await api(page, "PUT", "/api/rate-page", { slug: SLUG, live: true })).status).toBe(200);
  const made = await api(page, "POST", "/api/window-screens", { name: "Front window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true });
  expect(made.status).toBe(201);
  token = made.body.token; screenId = made.body.id;
  const published = (await api(page, "GET", `/api/public/rate-pages/${SLUG}`)).body;
  /* What the shop publishes, in its order (CI's board is alphabetical):
     the first currency with a flag image stands in for all of them. */
  const usd = published.rates.find((r: { code: string }) => IMAGED.includes(r.code));
  const code: string = usd.code;
  const home = published.shop.home;

  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/r/${SLUG}`);
  await expect(stranger.getByRole("heading", { level: 1 })).toHaveText(published.shop.name);
  const rates = stranger.getByRole("region", { name: "Today's rates" });
  await expect(rates.locator("[data-code]")).toHaveCount(published.rates.length);
  await expect(rates.locator("[data-code]").first()).toHaveAttribute("data-code", published.rates[0].code);
  await expect(rates.locator(`[data-code="${code}"]`)).toContainText(await nameOf(stranger, code));
  expect(await flagImage(stranger, code)).toMatch(/\/assets\/flags\/[a-z]{2}\.svg/);
  /* The publish time in the shop's own clock (its branch's time zone). */
  const at = await stranger.evaluate(([ms, zone]) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone as string }).format(new Date(ms as number)), [published.publishedAt, published.shop.timeZone] as const);
  await expect(rates).toContainText(`Published ${at}`);

  /* The design opens on buying foreign cash: you pay us at our selling rate. */
  const converter = stranger.getByRole("region", { name: "Work out your amount" });
  await converter.getByLabel("Currency").selectOption(code);
  await converter.getByLabel("Amount").fill("500");
  await expect(converter.getByRole("status")).toContainText("You pay us");
  await expect(converter.getByRole("status")).toContainText(await money(stranger, 500 * usd.sell, home));
  await converter.getByRole("button", { name: "I want to buy" }).click();
  await expect(converter.getByRole("button", { name: "I have foreign cash" })).toBeVisible();
  await expect(converter.getByRole("status")).toContainText("You get");
  await expect(converter.getByRole("status")).toContainText(await money(stranger, 500 * usd.buy, home));

  /* Display: the board full screen for a screen at the counter; Escape leaves. */
  await stranger.getByRole("button", { name: "Display" }).click();
  const tv = stranger.getByRole("dialog", { name: "Today's rates, full screen" });
  await expect(tv).toBeVisible();
  await expect(tv.locator("[data-flag]")).toHaveCount(published.rates.length);
  await stranger.keyboard.press("Escape");
  await expect(tv).toBeHidden();
  await stranger.close();
});

test("with the shop's week and regulator, the page says open or closed in the shop's clock and explains the rules", async ({ browser }) => {
  /* What the page does with a shop's week and regulator, which the owner
     sets in the rate page editor. The answer is the server's, with those
     fields added. */
  const stranger = await (await browser.newContext()).newPage();
  const real = await (await stranger.request.get(`/api/public/rate-pages/${SLUG}`)).json();
  const week = [null, [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [10, 16]];
  const regulator = {
    name: "Test Regulator", number: "M21-0098765", officer: "Priya Nair", body: "The national regulator",
    registryUrl: "https://example.test/register",
    rules: [{ when: "3,000", what: "We check your photo ID", why: "For any exchange of 3,000 or more." }],
    ids: ["Passport", "Driver's licence"],
  };
  let answer = { ...real, shop: { ...real.shop, timeZone: "America/Toronto", week, regulator } };
  await stranger.route(`**/api/public/rate-pages/${SLUG}`, (route) => route.fulfill({ json: answer }));
  /* Wednesday 10:00 in Toronto. */
  await stranger.clock.install({ time: new Date("2026-11-04T15:00:00Z") });
  await stranger.goto(`/r/${SLUG}`);
  await expect(stranger.getByText("Open now · closes 6 pm", { exact: true })).toBeVisible();
  const find = stranger.getByRole("region", { name: "Find us" });
  await expect(find.getByText("Mon to Fri", { exact: true })).toBeVisible();
  await expect(find.getByText("9:30 am to 6 pm", { exact: true })).toBeVisible();
  await expect(stranger.getByText("Registered with Test Regulator.")).toBeVisible();

  await stranger.getByRole("button", { name: "How we protect you →" }).click();
  await expect(stranger.getByRole("heading", { name: "How we keep your exchange on the record" })).toBeVisible();
  await expect(stranger.getByText("M21-0098765", { exact: true })).toBeVisible();
  await expect(stranger.getByText("Priya Nair", { exact: true })).toBeVisible();
  await expect(stranger.getByText("We check your photo ID")).toBeVisible();
  await expect(stranger.getByRole("link", { name: /Check our registration/ })).toHaveAttribute("href", "https://example.test/register");
  await stranger.getByRole("link", { name: "Today's rates" }).first().click();
  await expect(stranger.getByRole("region", { name: "Today's rates" })).toBeVisible();

  /* The same instant with Wednesday closed. */
  answer = { ...answer, shop: { ...answer.shop, week: [null, [9.5, 18], [9.5, 18], null, [9.5, 18], [9.5, 18], [10, 16]] } };
  await stranger.reload();
  await expect(stranger.getByText("Closed · opens tomorrow at 9:30 am", { exact: true })).toBeVisible();
  await expect(stranger.getByText("Opens tomorrow at 9:30 am", { exact: true })).toBeVisible();
  await stranger.close();
});

test("a shop that closes at midnight says 12 am, not 12 pm", async ({ browser }) => {
  const stranger = await (await browser.newContext()).newPage();
  const real = await (await stranger.request.get(`/api/public/rate-pages/${SLUG}`)).json();
  const late = [null, [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [9.5, 18], [18, 24]];
  await stranger.route(`**/api/public/rate-pages/${SLUG}`, (route) => route.fulfill({ json: { ...real, shop: { ...real.shop, timeZone: "America/Toronto", week: late } } }));
  /* Saturday 20:00 in Toronto. */
  await stranger.clock.install({ time: new Date("2026-11-08T01:00:00Z") });
  await stranger.goto(`/r/${SLUG}`);
  await expect(stranger.getByText("Open now · closes 12 am", { exact: true })).toBeVisible();
  await expect(stranger.getByRole("region", { name: "Find us" }).getByText("6 pm to 12 am", { exact: true })).toBeVisible();
  await stranger.close();
});

test("an address that is not live, or is not an address at all, says so", async ({ page }) => {
  await page.goto("/r/no-such-shop-here");
  await expect(page.getByText("This rate page is not available.")).toBeVisible();
  /* A stray % is a malformed escape: the server refuses it before any page. */
  for (const url of ["/r/broken%E0%A4%A", "/s/broken%ZZaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
    expect((await page.request.get(url)).status(), url).toBe(400);
  }
});

test("the window screen shows the top six with flags in two columns, dark, and goes blank when retired", async ({ page, browser }) => {
  const tv = await (await browser.newContext()).newPage();
  await tv.setViewportSize({ width: 1440, height: 810 });
  await tv.goto(`/s/${token}`);
  /* The design's start screen: one tap goes full screen and keeps it awake. */
  await expect(tv.getByText("Tap anywhere to start")).toBeVisible();
  await expect(tv.getByText("Front window")).toBeVisible();
  await tv.getByText("Tap anywhere to start").click();
  await expect(tv.getByText("Tap anywhere to start")).toBeHidden();
  await expect(tv.locator("[data-code]")).toHaveCount(6);
  const first = (await tv.locator("[data-code]").first().getAttribute("data-code"))!;
  if (IMAGED.includes(first)) expect(await flagImage(tv, first)).toMatch(/\/assets\/flags\/[a-z]{2}\.svg/);
  await expect(tv.locator(`[data-code="${first}"]`)).toContainText(await nameOf(tv, first));
  await expect(tv.locator("body")).toHaveClass("dark");
  await expect(tv.locator("#grid")).toHaveAttribute("data-columns", "2");
  await asOwner(page);
  expect((await api(page, "POST", `/api/window-screens/${screenId}/retire`)).status).toBe(200);
  await tv.close();
  /* The answer may sit in a browser's cache for up to 30 seconds
     (max-age=30); the screen asks every minute. A fresh browser is what
     the next poll sees. */
  const later = await (await browser.newContext()).newPage();
  await later.goto(`/s/${token}`);
  await expect(later.getByText("This screen link was replaced")).toBeVisible();
  await expect(later.getByText("The shop reset it. Open the new link from Rates → Website & window → Window screens.")).toBeVisible();
  await expect(later.locator("[data-code]")).toHaveCount(0);
  await later.close();
});

test("a screen that loses the connection keeps its rates up and says so", async ({ page, browser }) => {
  await asOwner(page);
  const made = await api(page, "POST", "/api/window-screens", { name: "Offline check", kind: "tv", layout: "one", theme: "light", currencies: [], showHours: false });
  const tv = await (await browser.newContext()).newPage();
  await tv.clock.install();
  await tv.goto(`/s/${made.body.token}`);
  await expect(tv.locator("[data-code]").first()).toBeVisible();
  await expect(tv.locator("#grid")).toHaveAttribute("data-columns", "1");
  await tv.route("**/api/public/screens/**", (route) => route.abort());
  await tv.clock.runFor(61_000);
  await expect(tv.getByText(/^Offline · showing rates from .+ · reconnecting$/)).toBeVisible();
  await expect(tv.locator("[data-code]").first()).toBeVisible();
  await tv.unroute("**/api/public/screens/**");
  await tv.clock.runFor(61_000);
  await expect(tv.getByText(/^Offline · showing rates/)).toBeHidden();
  await tv.close();
  await api(page, "POST", `/api/window-screens/${made.body.id}/retire`);
});

test("shots: the rate page at six widths, its display mode, and a window screen", async ({ page, browser }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  await asOwner(page);
  await api(page, "PUT", "/api/rate-page", { slug: SLUG, live: true });
  const stranger = await (await browser.newContext()).newPage();
  for (const width of [1440, 1280, 600, 430, 390, 360]) {
    await stranger.setViewportSize({ width, height: 900 });
    await stranger.goto(`/r/${SLUG}`);
    await expect(stranger.locator("[data-code]").first()).toBeVisible();
    await stranger.screenshot({ path: `docs/pr-shots/rates-public/rate-page-${width}.png`, fullPage: width <= 600 });
  }
  await stranger.setViewportSize({ width: 1440, height: 810 });
  await stranger.getByRole("button", { name: "Display" }).click();
  await stranger.screenshot({ path: "docs/pr-shots/rates-public/rate-page-display.png" });
  for (const theme of ["dark", "light"] as const) {
    const screen = await api(page, "POST", "/api/window-screens", { name: "Shot", kind: "tv", layout: "two", theme, currencies: [], showHours: true });
    await stranger.goto(`/s/${screen.body.token}`);
    await stranger.getByText("Tap anywhere to start").click();
    await expect(stranger.locator("[data-code]").first()).toBeVisible();
    await stranger.screenshot({ path: `docs/pr-shots/rates-public/window-screen-${theme}.png` });
    await api(page, "POST", `/api/window-screens/${screen.body.id}/retire`);
  }
  await stranger.close();
});
