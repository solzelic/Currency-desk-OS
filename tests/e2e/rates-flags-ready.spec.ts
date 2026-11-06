/* Rates opens with its flags already here.

   Rates draws a flag for every currency on the board, and the browser used
   to fetch all of them as the window opened (22 images, about 240 ms each
   from Israel), every time it opened. The flags are now kept for a day
   (server/src/app.ts), and the desk fetches the board's flags once it is up
   and idle, before anyone asks for Rates. Opening Rates then takes no flag
   from the network.

   This spec uses Playwright's own test, not ./fixtures: the fixtures route
   unpkg, the Tailwind CDN and Google Fonts, and Playwright turns the
   browser's HTTP cache off whenever a page routes requests, so no flag
   could ever come from the cache there. The compiled desk does not load
   unpkg or the Tailwind CDN; Google Fonts loads here as it does for a
   customer. */
import { test, expect } from "@playwright/test";
import { signInAtDesk } from "./fixtures";

test("the desk fetches the board's flags while idle, and Rates opens without fetching any", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const early = page.waitForRequest((r) => r.url().includes("/assets/flags/"), { timeout: 20_000 });
  await signInAtDesk(page, "r.haddad");
  await early;
  await page.waitForTimeout(2_000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  const cached = new Set<string>();
  const fromNetwork: string[] = [];
  cdp.on("Network.requestServedFromCache", (e: { requestId: string }) => { cached.add(e.requestId); });
  cdp.on("Network.responseReceived", (e: { requestId: string; response: { url: string; fromDiskCache?: boolean } }) => {
    if (e.response.url.includes("/assets/flags/") && !e.response.fromDiskCache && !cached.has(e.requestId)) fromNetwork.push(e.response.url);
  });

  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await expect(page.locator("[data-rates]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-rate-row]").first()).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(fromNetwork).toEqual([]);
});
