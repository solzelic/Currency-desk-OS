/* A locked password step on a phone.

   The account counter trips at five, so each size spends five guesses
   on an id that is not a person at the desk and then stops. It does
   not sign in as a seeded teller. A second run of the suite gets a
   fresh in-memory database, so these five do not pile onto a later run.

   While the lock holds, the button reads Sign in and is disabled.
   It comes back as Send my code when the server's lock time passes.
   The sentence names that time once, without a zone label.
   A 503 is intercepted, so it does not spend a guess. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const SENTENCE = /Too many tries\. Try again at \d{1,2}:\d{2} (AM|PM)\./;

async function contrastAgainstWhite(page: Page, text: RegExp): Promise<number> {
  return page.getByText(text).evaluate((el) => {
    const match = getComputedStyle(el).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const channels = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [255, 255, 255];
    const lin = (channel: number) => {
      const s = channel / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const L = (rgb: number[]) => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
    const fg = L(channels);
    const bg = L([255, 255, 255]);
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
  });
}

async function openPassword(page: Page, staffId: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  await page.getByPlaceholder("your-staff-id").fill(staffId);
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.locator('input[type="password"]')).toBeVisible();
}

test.describe("locked sign-in", () => {
  for (const width of [360, 390]) {
    test(`the lock ends on screen at ${width}`, async ({ page }) => {
      await page.clock.install();
      await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
      await openPassword(page, `lock${width}${Date.now().toString(36)}`);
      const password = page.locator('input[type="password"]');
      const send = page.getByRole("button", { name: /send my code/i });
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await page.getByText(SENTENCE).isVisible()) break;
        await password.fill("wrong-password-lock");
        const pending = page.waitForResponse(
          (res) => res.url().includes("/api/auth/login/start") && res.request().method() === "POST",
        );
        await send.click();
        await pending;
      }

      const status = page.getByText(SENTENCE);
      await expect(status).toBeVisible();
      expect(await contrastAgainstWhite(page, SENTENCE)).toBeGreaterThanOrEqual(4.5);
      const signIn = page.getByRole("button", { name: "Sign in" });
      await expect(signIn).toBeDisabled();
      await expect(signIn.locator("svg")).toBeVisible();
      await expect(page.getByRole("button", { name: /send my code/i })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^locked$/i })).toHaveCount(0);
      await expect(page.getByText(/Another code/)).toHaveCount(0);
      await expect(page.getByText(/\((EDT|EST|AM|PM)\)/)).toHaveCount(0);
      await expect(page.getByText("We'll email a fresh code to confirm it's you.")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send yourself a reset code" })).toBeVisible();
      for (const name of ["not you?", "Send yourself a reset code", "SHOW"]) {
        const box = await page.getByRole("button", { name }).boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
      }

      await page.clock.fastForward(16 * 60 * 1000);
      await expect(page.getByRole("button", { name: /send my code/i })).toBeEnabled();
    });
  }

  test("a lock with no server time says a few minutes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, `notime${Date.now().toString(36)}`);
    await page.route("**/api/auth/login/start", (route) => route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "too_many_attempts" }),
    }));
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: /send my code/i }).click();
    await expect(page.getByText("Too many tries. Try again in a few minutes.")).toBeVisible();
    const again = page.getByRole("button", { name: "Try again" });
    await expect(again).toBeEnabled();
    await again.click();
    await expect(page.getByText("Too many tries. Try again in a few minutes.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  test("resending a code while locked says the same time", async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 390, height: 844 });
    let calls = 0;
    await page.route("**/api/auth/login/start", (route) => {
      calls += 1;
      if (calls === 1) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            needsCode: true,
            maskedEmail: "s•••@shop.example",
            user: { id: "sam@shop.example", name: "Sam", role: "teller" },
          }),
        });
      }
      return route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "too_many_attempts", until: "5:04 AM" }),
      });
    });
    await openPassword(page, "sam@shop.example");
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: /send my code/i }).click();
    await expect(page.getByText("Check your email")).toBeVisible();
    await page.clock.fastForward(121_000);
    await page.getByRole("button", { name: "Resend" }).click();
    await expect(page.getByText("Too many tries. Try again at 5:04 AM.")).toBeVisible();
  });

  test("a 503 says sign-in is having trouble", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openPassword(page, `svc${Date.now().toString(36)}`);
    await page.route("**/api/auth/login/start", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "email_unavailable", detail: "Sign-in service error (503)" }),
    }));
    await page.locator('input[type="password"]').fill("wrong-password-lock");
    await page.getByRole("button", { name: /send my code/i }).click();
    await expect(page.getByText("Sign-in is having trouble. Try again in a minute.")).toBeVisible();
  });
});
