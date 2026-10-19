/* Loads the Visit quote widget. Deleting the 429 branch fails the first test. */
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";

const WAIT = "Too many tries. Wait a minute and try again.";
const FOOTER = "The held rate is honoured at the desk with this ref. Government-issued ID required for transactions over CAD $3,000. FINTRAC regulation.";
const DASH = /[\u2013\u2014]/;
const CONFIRM = "**/api/sites/yorkfx/quotes/*/confirm";
const CREATE = (url: URL) => url.pathname.endsWith("/api/sites/yorkfx/quotes");

async function open(page: Page) {
  const config = page.waitForResponse((res) => res.url().endsWith("/api/sites/yorkfx/config") && res.ok());
  await page.goto("/sites/yorkfx/YorkFX%20Visit.html");
  await config;
}

async function hold(page: Page, phone: string) {
  await open(page);
  await page.locator("#qAmount").fill("100");
  await page.locator("#qFrom").selectOption("CAD");
  await page.locator("#qTo").selectOption("USD");
  await page.locator("#qPhone").fill(phone);
  const created = page.waitForResponse((res) => CREATE(new URL(res.url())) && res.request().method() === "POST");
  await page.locator("#quoteForm button[type=submit]").click();
  expect((await created).status()).toBe(201);
  await page.locator("#quoteConfirm").waitFor();
}

test("a limited confirm tells the visitor to wait a minute", async ({ page }) => {
  await page.route(CONFIRM, (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "slow_down", detail: WAIT }) }));
  await hold(page, "4165551201");
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteConfirmNote")).toHaveText(WAIT);
  await expect(page.locator("#quote p.fine").last()).toHaveText(FOOTER);
});

test("confirm shows the ref to bring to the desk", async ({ page }) => {
  await hold(page, "4165551202");
  const held = await page.locator("#quoteResult").innerText();
  expect(held).toMatch(/Held for you until \d{1,2}:\d{2} (am|pm)\./);
  expect(held).not.toContain("..");
  const ref = (held.match(/Q-\d{4}/) ?? [])[0];
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteRefLine")).toHaveText(`Show ref ${ref} at the desk.`);
  await expect(page.locator("#quote p.fine").last()).toHaveText(FOOTER);
});

test("quote card copy has no em or en dash", () => {
  const html = readFileSync("YorkFX/YorkFX Visit.html", "utf8");
  const at = html.indexOf('id="quote"');
  const aside = html.slice(at, html.indexOf("</aside>", at));
  const js = readFileSync("YorkFX/yorkfx-site-config.js", "utf8");
  const text = `${aside}\n${js.slice(js.indexOf("---------- SMS quote widget"))}`;
  expect(text).not.toMatch(DASH);
  for (const line of [
    "Text me today's rate. Held for 30 minutes", "for 30 minutes. No obligation",
    "CAD, you give", "USD, you receive", "Text me this rate. Held 30 min",
    "I’m coming. Set it aside", "Held for you until", "Confirmed.", "Show ref ", "at the desk.",
    WAIT, "Couldn’t confirm. The hold may have expired.", "Couldn’t get a quote. Try again or call the desk.",
    "Couldn’t reach the desk. Try again in a moment.", "Quotes are offline right now. Call the desk",
    "Enter the amount you’re exchanging.", "Pick two different currencies.", "Enter a mobile number we can text.",
    FOOTER,
  ]) expect(text, line).toContain(line);
});
