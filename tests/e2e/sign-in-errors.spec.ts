/* The staff sign-in door, as a person sees it.

   The lock stage renders SignIn from os-src/cdos-signin.jsx, and that
   is the page at /login. A wrong password, an account the server will
   not admit, and any other refusal used to put an HTTP status in the
   sentence, or fall through to a sentence that did. Reading the source
   for those words would stay green if the screen stopped showing them,
   so this types an ID and a password and reads the line the screen shows.
*/
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const WRONG_PASSWORD = "That password does not match this ID. Try again, or send yourself a reset code.";
const CANNOT_SIGN_IN = "This account cannot sign in.";
const OTHER_REFUSAL = "The desk could not sign you in. Wait a moment and try again.";

async function openPassword(page: Page) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByPlaceholder("your-staff-id").fill("desk.clerk");
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByPlaceholder("••••••••").fill("not-the-password");
}

async function refuse(page: Page, status: number) {
  await page.route("**/api/auth/login/start", (route) => route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: "unlisted" }),
  }));
  await page.getByRole("button", { name: "Send my code" }).click();
}

async function shownError(page: Page, sentence: string) {
  const line = page.locator("#lock div").filter({ hasText: sentence }).filter({ hasNot: page.locator("div") });
  await expect(line).toHaveCount(1);
  const text = (await line.innerText()).trim();
  expect(text).toBe(sentence);
  expect(text).not.toMatch(/\b[1-5]\d{2}\b/);
  expect(text).not.toMatch(/sign-in service error/i);
}

test("a wrong password is a sentence with no status number", async ({ page }) => {
  await openPassword(page);
  await refuse(page, 401);
  await shownError(page, WRONG_PASSWORD);
});

test("an account the server will not admit is a sentence with no status number", async ({ page }) => {
  await openPassword(page);
  await refuse(page, 403);
  await shownError(page, CANNOT_SIGN_IN);
});

test("any other sign-in refusal is a sentence with no status number", async ({ page }) => {
  await openPassword(page);
  await refuse(page, 500);
  await shownError(page, OTHER_REFUSAL);
});
