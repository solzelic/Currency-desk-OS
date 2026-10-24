/* Ledger list and deal detail on the one clock.
   The stored date and time are wrong on purpose. The instant is
   2026-06-18 19:43 UTC, which is 3:43 pm on the Toronto civil day.
   The browser zone is UTC so a local slice would miss that day. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, signInAtDesk, landOnDesktop, type Page } from "./fixtures";

const DIR = path.join(process.cwd(), "docs/pr-shots/desk-clock");
const WIDTHS = [360, 390, 430, 1280];

test.use({ timezoneId: "UTC" });

async function plant(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.timeFormat = "12h";
    raw.timezone = "America/Toronto";
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    localStorage.setItem("cdos_rows_v1", JSON.stringify([{
      id: "clk1", ref: "LT-CLK-001", date: "2026-06-17", time: "19:43",
      at: Date.parse("2026-06-18T19:43:00.000Z"),
      customer: "Night Desk", type: "Currency Exchange",
      inCcy: "CAD", inAmt: 100, rate: 1.4, outCcy: "USD", outAmt: 70, fee: 2,
      teller: "A. Singh", status: "posted", thread: [],
    }]));
  });
}

for (const width of WIDTHS) {
  test(`ledger and deal at ${width}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await page.clock.install({ time: new Date("2026-06-18T19:43:00Z") });
    await page.setViewportSize({ width, height: 800 });
    await signInAtDesk(page);
    await plant(page);
    await page.reload();
    await landOnDesktop(page);
    await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("ledger"));
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await expect(page.locator(".cdos-tour")).toHaveCount(0);
    const win = page.locator("#desktop .win.show.active").first();
    const clock = win.getByText("3:43 pm").first();
    await clock.scrollIntoViewIfNeeded();
    await expect(clock).toBeVisible();
    await expect(win.getByText("2026-06-18").first()).toBeVisible();
    if (width > 430) await expect(page.locator(".mb-clock")).toContainText("3:43 pm");
    await win.screenshot({ path: path.join(DIR, `ledger-${width}.png`) });
    await clock.click();
    const detail = page.locator(".tx-detail-head");
    await expect(detail).toContainText("3:43 pm");
    await expect(detail).toContainText("2026-06-18");
    await win.screenshot({ path: path.join(DIR, `detail-${width}.png`) });
  });
}
