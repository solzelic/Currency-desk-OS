/* Loads the Visit quote widget. Deleting the 429 branch fails the first test. */
import { test, expect, type Page } from "./fixtures";

const WAIT = "Too many tries. Wait a minute and try again.";
const CONFIRM = "**/api/sites/yorkfx/quotes/*/confirm";

async function hold(page: Page, phone: string) {
  const config = page.waitForResponse((res) => res.url().endsWith("/api/sites/yorkfx/config") && res.ok());
  await page.goto("/sites/yorkfx/YorkFX%20Visit.html");
  await config;
  await page.locator("#qAmount").fill("100");
  await page.locator("#qFrom").selectOption("CAD");
  await page.locator("#qTo").selectOption("USD");
  await page.locator("#qPhone").fill(phone);
  const created = page.waitForResponse((res) => res.url().endsWith("/api/sites/yorkfx/quotes") && res.request().method() === "POST");
  await page.locator("#quoteForm button[type=submit]").click();
  expect((await created).status()).toBe(201);
  await page.locator("#quoteConfirm").waitFor();
}

test("a limited confirm tells the visitor to wait a minute", async ({ page }) => {
  await page.route(CONFIRM, (route) => route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "slow_down", detail: WAIT }) }));
  await hold(page, "4165551201");
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteConfirmNote")).toHaveText(WAIT);
});

test("confirm shows the ref to bring to the desk", async ({ page }) => {
  await hold(page, "4165551202");
  const held = await page.locator("#quoteResult").innerText();
  expect(held).toMatch(/Held for you until \d{1,2}:\d{2} (am|pm)\./);
  expect(held).not.toContain("..");
  const ref = (held.match(/Q-\d{4}/) ?? [])[0];
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteRefLine")).toHaveText(`Show ref ${ref} at the desk.`);
});
