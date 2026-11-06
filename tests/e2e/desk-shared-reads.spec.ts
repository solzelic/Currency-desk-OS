/* The desk never has the same ledger read in flight twice.

   Reports, the Dashboard, the Cash Drawer and the Vault each asked the
   ledger for the same things several times at once as they opened (Reports:
   the day's summary six times, the position three times, the till session
   four). os-src/cdos-backend.js now shares a read that is already on its
   way. This walks those screens and watches every ledger GET: a second one
   for the same address while the first is still out is the regression. */
import type { Page, Request } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

function watch(page: Page) {
  const out = new Map<Request, string>();
  const twice: string[] = [];
  const asked = (r: Request) => {
    const url = new URL(r.url());
    if (r.method() !== "GET" || !url.pathname.startsWith("/api/ledger/")) return;
    const key = url.pathname + url.search;
    if ([...out.values()].includes(key)) twice.push(key);
    out.set(r, key);
  };
  const ended = (r: Request) => { out.delete(r); };
  page.on("request", asked);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return twice;
}

test("opening Reports, the Dashboard, the Cash Drawer and the Vault asks each ledger read once at a time", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const twice = watch(page);
  for (const app of ["reports", "dashboard", "till", "vault"]) {
    await page.evaluate((id) => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp(id), app);
    await expect(page.locator(".win.show.active").first()).toBeVisible();
    await page.waitForTimeout(2_000);
    await page.locator(".win.show.active .win-close").first().click();
  }
  expect(twice).toEqual([]);
});
