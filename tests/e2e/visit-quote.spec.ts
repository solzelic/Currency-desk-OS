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

test("confirm says the text went out", async ({ page }) => {
  await hold(page, "4165551202");
  const held = await page.locator("#quoteResult").innerText();
  expect(held).toMatch(/Held for you until \d{1,2}:\d{2} (am|pm)\./);
  expect(held).not.toContain("..");
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteTextStatus")).toHaveText("We texted you the details.");
});

test("confirm says the text did not go out", async ({ page }) => {
  await page.route(CONFIRM, async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.json();
    body.quote.textSent = false;
    await route.fulfill({ status: upstream.status(), contentType: "application/json", body: JSON.stringify(body) });
  });
  await hold(page, "4165551203");
  const ref = ((await page.locator("#quoteResult").innerText()).match(/Q-\d{4}/) ?? [""])[0];
  await page.locator("#quoteConfirm").click();
  await expect(page.locator("#quoteTextStatus")).toHaveText(`We couldn\u2019t send the text. Show ref ${ref} at the desk.`);
});
