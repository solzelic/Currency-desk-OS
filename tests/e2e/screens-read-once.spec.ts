/* A screen reads its figures once as it opens, not again a moment later.

   Every desk screen asks for the desk's facts as it mounts (the pack, the
   desk's thresholds, the till's trading day) through useDeskFacts, and
   re-derives when they arrive. The answer is nearly always the one the
   desk already had, but it still moved the hook's version, so Reports, the
   Dashboard, the Cash Drawer and the Vault read their figures, waited for
   the facts, then read the same figures again: two round trips, about
   240 ms each from Israel. Now the version moves only when a fact changed.

   This opens those screens and fails on a ledger read asked again after
   the same read was already answered. The Cash Drawer is not in it: it
   re-reads the day's figures on purpose when its till session arrives
   (cdos-till.jsx), which a desk with an open till always does. */
import type { Page, Request } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

function watch(page: Page) {
  const answered = new Set<string>();
  const again: string[] = [];
  const keyOf = (r: Request) => {
    const url = new URL(r.url());
    return r.method() === "GET" && url.pathname.startsWith("/api/ledger/") ? url.pathname + url.search : null;
  };
  page.on("request", (r) => { const key = keyOf(r); if (key && answered.has(key)) again.push(key); });
  page.on("requestfinished", (r) => { const key = keyOf(r); if (key) answered.add(key); });
  return { again, reset: () => answered.clear() };
}

test("Reports, the Dashboard and the Vault read each figure once as they open", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.waitForTimeout(2_000);
  const seen = watch(page);
  const found: Record<string, string[]> = {};
  for (const app of ["reports", "dashboard", "vault"]) {
    seen.reset();
    const before = seen.again.length;
    await page.evaluate((id) => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp(id), app);
    await expect(page.locator(".win.show.active").first()).toBeVisible();
    await page.waitForTimeout(2_500);
    found[app] = seen.again.slice(before);
    await page.locator(".win.show.active .win-close").first().click();
    await page.waitForTimeout(300);
  }
  expect(found).toEqual({ reports: [], dashboard: [], vault: [] });
});
