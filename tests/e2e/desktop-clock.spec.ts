/* The menubar clock is a clock. It follows the browser's zone and
   the desk's time format, which defaults to 12-hour.
   This spec freezes 15:02 UTC and pins the browser to UTC, so the
   same assertion holds when the suite itself is running under
   Asia/Jerusalem, America/Toronto, or Pacific/Auckland.

   Drop the timezoneId pin and run under Asia/Jerusalem: that instant
   renders 6:02 pm and this test goes red. A calendar day (an ID expiry,
   a sign-off day) is not pinned this way. Those stay on the civil day.
*/
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

test.use({ timezoneId: "UTC" });

test("the desktop clock reads 3:02 pm in the pinned zone", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T15:02:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator(".mb-clock")).toContainText("3:02 pm");
});

/* 16:05 with the desk on 12-hour. Main prints 16:05. The header
   should read 4:05 pm, the same shape as the public hold time. */
test("the header clock reads 4:05 pm when 12-hour is set", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.timeFormat = "12h";
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  });
  await page.reload();
  await landOnDesktop(page);
  await expect(page.locator("#menubar")).toBeVisible();
  const clock = page.locator(".mb-clock");
  await expect(clock).toContainText("4:05 pm");
  await expect(clock).not.toContainText("16:05");
});

test("the header clock stays 16:05 when 24-hour is set", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.timeFormat = "24h";
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  });
  await page.reload();
  await landOnDesktop(page);
  const clock = page.locator(".mb-clock");
  await expect(clock).toContainText("16:05");
  await expect(clock).not.toContainText("pm");
});
