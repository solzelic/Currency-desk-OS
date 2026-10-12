/* A locked password step on a phone.

   The account counter trips at five, so this spends five guesses on
   an id that is not a person at the desk and then stops. It does not
   sign in as a seeded teller, and it does not keep guessing once the
   lock is on the screen. A second run of the suite gets a fresh
   in-memory database, so these five do not pile onto a later run.

   The screen used to start the resend countdown from `retryAfter`,
   which turned a fifteen-minute lock into "Another code in 900s" and
   left the "we'll email a code" line under a staff id that has no
   inbox. This fails if that comes back. */
import { test, expect } from "./fixtures";

test("a locked staff id shows the branch clock and a locked button", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  await expect(page.getByPlaceholder("your-staff-id")).toBeVisible();
  await page.getByPlaceholder("your-staff-id").fill("lock" + Date.now().toString(36));
  await page.getByRole("button", { name: /continue/i }).click();
  const password = page.locator('input[type="password"]');
  await expect(password).toBeVisible();

  const locked = page.getByRole("button", { name: "Locked" });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await locked.isVisible()) break;
    await password.fill("wrong-password-lock");
    const pending = page.waitForResponse(
      (res) => res.url().includes("/api/auth/login/start") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: /send my code/i }).click();
    await pending;
    await expect(page.getByText(/Try again at|That password/).first()).toBeVisible();
  }

  await expect(page.getByText(/Try again at \d{1,2}:\d{2} (AM|PM)/)).toBeVisible();
  await expect(locked).toBeDisabled();
  await expect(page.getByText("We'll email a fresh code to confirm it's you.")).toHaveCount(0);
  await expect(page.getByText(/Another code/)).toHaveCount(0);
});
