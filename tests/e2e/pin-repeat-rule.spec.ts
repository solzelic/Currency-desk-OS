/* Set PIN says why a repeated-digit PIN is refused (Sol, 3 Nov 2026; #615).
   It used to say "That didn't save. Try again." */
import { test, expect, signInAtDesk } from "./fixtures";

const REPEAT = "Pick a PIN that isn't one digit repeated, like 1111.";

test("Set PIN shows why 1111 is refused, and takes 1100", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "a.singh");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("settings"));
  await page.locator("button:not(.mb-acct)", { hasText: "A. Singh" }).first().click();
  await page.getByRole("button", { name: /^(Set|Change) PIN$/ }).click();
  const fields = page.locator('input[placeholder="••••"]');
  const filled = await fields.count();
  if (filled === 3) await fields.nth(0).fill("1100");   // this test set it on an earlier run
  await fields.nth(filled - 2).fill("1111");
  await fields.nth(filled - 1).fill("1111");
  await page.getByRole("button", { name: /Save PIN/ }).click();
  await expect(page.getByText(REPEAT)).toBeVisible();
  await expect(page.getByText(/didn.t save/)).toHaveCount(0);
  await fields.nth(filled - 2).fill("1100");
  await fields.nth(filled - 1).fill("1100");
  await page.getByRole("button", { name: /Save PIN/ }).click();
  await expect(page.getByText("PIN updated")).toBeVisible();
});
