/* The menubar clock is a clock. It follows the browser's zone.
   This spec freezes 15:02 UTC and pins the browser to UTC, so the
   same assertion holds when the suite itself is running under
   Asia/Jerusalem, America/Toronto, or Pacific/Auckland.

   Drop the timezoneId pin and run under Asia/Jerusalem: that instant
   renders 18:02 and this test goes red. A calendar day (an ID expiry,
   a sign-off day) is not pinned this way. Those stay on the civil day.
*/
import { test, expect, signInAtDesk } from "./fixtures";

test.use({ timezoneId: "UTC" });

test("the desktop clock reads 15:02 in the pinned zone", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T15:02:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator(".mb-clock")).toContainText("15:02");
});
