/* Set PIN says why a repeated-digit PIN is refused (Sol, 3 Nov 2026; #615).
   It used to say "That didn't save. Try again." */
import { test, expect, signInAtDesk } from "./fixtures";

const REPEAT = "Pick a PIN that isn't one digit repeated, like\u00a01111.";

test("Set PIN shows why 1111 is refused, and takes 2468", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  /* J. Masri, and 2468: the PIN the till-handover spec gives its approver.
     No spec needs J. Masri without a PIN, and A. Singh has to stay without one. */
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("settings"));
  await page.locator("button:not(.mb-acct)", { hasText: "J. Masri" }).first().click();
  await page.getByRole("button", { name: /^(Set|Change) PIN$/ }).click();
  const fields = page.locator('input[placeholder="••••"]');
  const filled = await fields.count();
  if (filled === 3) await fields.nth(0).fill("2468");   // set by till-handover or an earlier run
  await fields.nth(filled - 2).fill("1111");
  await fields.nth(filled - 1).fill("1111");
  await page.getByRole("button", { name: /Save PIN/ }).click();
  await expect(page.getByText(REPEAT)).toBeVisible();
  await expect(page.getByText(/didn.t save/)).toHaveCount(0);
  /* The error is announced, and both new PIN fields point at it. */
  const err = page.locator("#pin-set-err");
  await expect(err).toHaveAttribute("role", "alert");
  await expect(err).toContainText(REPEAT);
  for (const i of [filled - 2, filled - 1]) {
    await expect(fields.nth(i)).toHaveAttribute("aria-describedby", "pin-set-err");
    await expect(fields.nth(i)).toHaveAttribute("aria-invalid", "true");
  }
  await fields.nth(filled - 2).fill("2468");
  await fields.nth(filled - 1).fill("2468");
  await page.getByRole("button", { name: /Save PIN/ }).click();
  await expect(page.getByText("PIN updated")).toBeVisible();
});

/* Dark theme on a phone: the top bar is the ink surface with paper text,
   as the desktop dark bar is. */
for (const width of [360, 390, 430]) {
  test(`the dark phone top bar is ink with paper text at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await signInAtDesk(page, "a.singh");
    await page.evaluate(() => (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("dark"));
    const head = page.locator(".phone-head");
    await expect(head).toHaveCSS("background-color", "rgb(23, 20, 15)");
    for (const sel of [".phone-shop", ".phone-till", ".mb-acct-id b"]) {
      await expect(head.locator(sel).first(), sel).toHaveCSS("color", "rgb(247, 244, 237)");
    }
  });
}
