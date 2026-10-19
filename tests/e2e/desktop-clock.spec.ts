/* The menubar clock is a clock. It follows the desk timezone
   (settings.timezone, America/Toronto unless the desk changed it)
   and the desk's time format, which defaults to 12-hour.
   It does not follow the browser zone.

   Most of these tests pin the browser to UTC and set the desk zone
   to UTC, so a frozen instant is the wall time under test wherever
   the suite itself is running. The Auckland test leaves the browser
   in Pacific/Auckland and the desk in America/Toronto.
*/
import { test, expect, signInAtDesk, landOnDesktop, type Page } from "./fixtures";

test.use({ timezoneId: "UTC" });

async function setDeskClock(page: Page, fields: { timeFormat?: string; timezone?: string }): Promise<void> {
  await page.evaluate((next) => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    Object.assign(raw, next);
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
  }, fields);
  await page.reload();
  await landOnDesktop(page);
}

test("the desktop clock reads 3:02 pm in the pinned zone", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T15:02:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await setDeskClock(page, { timeFormat: "12h", timezone: "UTC" });
  await expect(page.locator("#menubar")).toBeVisible();
  await expect(page.locator(".mb-clock")).toContainText("3:02 pm");
});

/* 16:05 with the desk on 12-hour. Main prints 16:05. The header
   should read 4:05 pm, the same shape as the public hold time. */
test("the header clock reads 4:05 pm when 12-hour is set", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await setDeskClock(page, { timeFormat: "12h", timezone: "UTC" });
  await expect(page.locator("#menubar")).toBeVisible();
  const clock = page.locator(".mb-clock");
  await expect(clock).toContainText("4:05 pm");
  await expect(clock).not.toContainText("16:05");
});

test("the header clock keeps the same width at 9:59 am and 12:45 pm", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T09:59:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await setDeskClock(page, { timeFormat: "12h", timezone: "UTC" });
  const clock = page.locator(".mb-clock");
  await expect(clock).toContainText("9:59 am");
  const atNine = await clock.evaluate((el) => el.getBoundingClientRect().width);
  await page.clock.setSystemTime(new Date("2026-06-18T12:45:00Z"));
  await page.clock.runFor(1000);
  await expect(clock).toContainText("12:45 pm");
  const atTwelve = await clock.evaluate((el) => el.getBoundingClientRect().width);
  const fits = await clock.locator("b").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);
  expect(atNine).toBe(atTwelve);
});

test("the header clock stays 16:05 when 24-hour is set", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await setDeskClock(page, { timeFormat: "24h", timezone: "UTC" });
  const clock = page.locator(".mb-clock");
  await expect(clock).toContainText("16:05");
  await expect(clock).not.toContainText("pm");
});

/* 16:05 UTC is 12:05 pm in Toronto and 4:05 am in Auckland.
   The browser is Auckland. The desk zone is Toronto. */
test.describe("the desk zone, not the browser", () => {
  test.use({ timezoneId: "Pacific/Auckland" });

  test("the header clock reads the desk timezone when the browser is somewhere else", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAtDesk(page);
    await setDeskClock(page, { timeFormat: "12h", timezone: "America/Toronto" });
    const clock = page.locator(".mb-clock");
    await expect(clock).toContainText("12:05 pm");
    await expect(clock).not.toContainText("4:05 am");
  });
});

test("the audit trail opens in 12-hour and 24-hour with no console error", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.clock.install({ time: new Date("2026-06-18T16:05:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  for (const timeFormat of ["12h", "24h"] as const) {
    errors.length = 0;
    await setDeskClock(page, { timeFormat, timezone: "UTC" });
    await page.evaluate(() => window.CDOS.openApp("audit"));
    const trail = page.locator(".win.show.active").getByText("Audit Trail").first();
    const opened = await trail.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
    expect(errors, timeFormat).toEqual([]);
    expect(opened, timeFormat).toBe(true);
  }
});
