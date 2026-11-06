/* Cost & stock shows what the Board already read.

   Opening Rates, the Board reads the board (/api/rates), the market
   (/api/rates/market), the desk's position (/api/ledger/position) and the
   cost method. Cost & stock then asked for all four again, a round trip of
   about 240 ms each from Israel, before it could show anything. It now
   takes the Board's answers (a minute old at most) and asks only for the
   cash bought lately, which the Board does not read.

   After Record cash bought the position has changed, so it is read again,
   and the ledger's new figure is what the tab shows. */
import type { Page, Request } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

const BOARD_READS = ["/api/rates", "/api/rates/market", "/api/ledger/position", "/api/ledger/cost-method"];

/* Open Rates and wait for the Board's four reads to be answered. */
async function openBoard(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const answered = BOARD_READS.map((path) => page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === "GET"));
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await expect(page.locator("[data-rates]")).toBeVisible({ timeout: 30_000 });
  await Promise.all(answered);
}

/* Every GET under /api/ while `act` runs. */
async function getsDuring(page: Page, act: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const note = (r: Request) => {
    const url = new URL(r.url());
    if (r.method() === "GET" && url.pathname.startsWith("/api/")) seen.push(url.pathname);
  };
  page.on("request", note);
  try { await act(); } finally { page.off("request", note); }
  return seen;
}

const usdOnHand = (page: Page) => page.evaluate(async () => {
  const pos = await (await fetch("/api/ledger/position")).json() as { currencies?: Array<{ currency: string; quantity: string }> };
  const usd = (pos.currencies || []).find((c) => c.currency === "USD");
  return usd ? Number(usd.quantity) : 0;
});
const shown = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 2 });

test("Cost & stock shows the Board's reads without asking for them again", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL");
  await openBoard(page);
  const seen = await getsDuring(page, async () => {
    await page.getByRole("tab", { name: "Cost & stock" }).click();
    await expect(page.getByText("Cash at cost", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Recent cash bought" })).toBeVisible();
    await page.waitForTimeout(1_500);
  });
  for (const path of BOARD_READS) expect(seen, path).not.toContain(path);
  expect(seen).toContain("/api/ledger/vault/movements");
});

test("after Record cash bought, Cost & stock reads the position again and shows the ledger's figure", async ({ page }) => {
  test.skip(!hasLedger, "needs SEAM_DATABASE_URL");
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, "r.haddad");
  /* A vault the ledger knows about: state it once if this desk never has. */
  await page.evaluate(async () => {
    await fetch("/api/ledger/vault/opening-position", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ balances: { USD: "0.00" } }) });
  });
  await openBoard(page);
  await page.getByRole("tab", { name: "Cost & stock" }).click();
  await expect(page.getByText("Cash at cost", { exact: true })).toBeVisible();
  const before = await usdOnHand(page);

  await page.getByRole("button", { name: "Record cash bought" }).first().click();
  const sheet = page.getByRole("dialog", { name: "Record cash bought" });
  await sheet.getByRole("button", { name: /^USD/ }).click();
  await sheet.getByLabel(/^Amount you got/).fill("1000");
  await sheet.getByLabel(/^Total you paid/).fill("1350");
  await sheet.getByLabel("Bought from").fill("E2E Reuse Wholesaler");
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/ledger/vault/receipts") && r.request().method() === "POST");
  const seen = await getsDuring(page, async () => {
    await sheet.getByRole("button", { name: "Record", exact: true }).click();
    expect((await sent).ok()).toBe(true);
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("region", { name: "Recent cash bought" })).toContainText("E2E Reuse Wholesaler");
  });
  expect(seen).toContain("/api/ledger/position");

  const after = await usdOnHand(page);
  expect(after).toBe(before + 1000);
  await expect(page.locator('[data-stock-row="USD"]')).toContainText(shown(after));
});
