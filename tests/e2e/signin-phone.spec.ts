/* The platform sign-in card used to stay 380px wide inside 24px of
   padding, so a 390px phone scrolled about 15px sideways. The desk
   sign-in placeholder said "your-staff-id" while the help text asked
   for an email or an ID. Both pages have to fit at 360 and 390, and
   the desk field has to name what the server actually accepts. */
import { test, expect } from "./fixtures";

async function sideways(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("admin and desk sign-in fit a phone, and the desk field names what it accepts", async ({ page }) => {
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await sideways(page), `/admin at ${width}px`).toBeLessThanOrEqual(0);

    await page.goto("/login");
    const lock = page.locator("#lock");
    await expect(lock).toBeVisible();
    expect(await sideways(page), `/login at ${width}px`).toBeLessThanOrEqual(0);
    await expect(lock.locator("input").first()).toHaveAttribute("placeholder", "email, staff ID, or CD-ID");
    await expect(lock).toContainText("Your email address, the staff ID your desk gave you, or your CurrencyDesk ID (CD-YORK-0042).");
  }
});
