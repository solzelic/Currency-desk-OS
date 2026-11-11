/* ============================================================
   Low stock is the owner's floor, not York FX's.

   The Vault carried York FX's own reorder levels (CAD 120,000, USD
   40,000 and so on) as the fallback for every shop, so a desk that had
   set no floor saw Low stock on every currency it held, 40,000 CAD
   included (CD-133, GitHub #623). The Rates app's Cost & stock only
   ever read the owner's floors, so the two screens disagreed about
   the same safe.

   A floor nobody set is no floor: nothing is flagged. A floor the
   owner sets in Settings flags that currency, and only that one.
   ============================================================ */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL: the embedded database has no vault");

/* The owner's own safe, declared once if this book has none yet. On a
   shared book an earlier spec may have declared it already; the figures
   then are whatever it holds, and the test reads them. */
async function vaultWithUsd(page: Page): Promise<number> {
  const book = ledger(page);
  let vault = await book.vault();
  if (!vault.tracked) {
    await page.evaluate(async () => {
      await fetch("/api/ledger/vault/opening-position", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "40000.00", USD: "20000.00" } }),
      });
    });
    vault = await book.vault();
  }
  const usd = Number((vault.balances as Record<string, string>).USD ?? "0");
  if (!(usd > 0)) {
    /* A safe declared with no dollars in it: put some in through the
       receipt the Vault itself uses, so there is a row to flag. */
    await page.evaluate(async () => {
      await fetch("/api/ledger/vault/receipts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: `floors-usd-${Date.now()}`, direction: "in", currency: "USD", amount: "1000.00", counterpartyRef: "Floors test" }),
      });
    });
    vault = await book.vault();
  }
  return Number((vault.balances as Record<string, string>).USD ?? "0");
}

const vaultWindow = (page: Page) => page.locator(".win", { hasText: /Cash on Hand · Vault/i });

test("nothing is Low stock until the owner sets a floor, and then only that currency is", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  const usd = await vaultWithUsd(page);
  expect(usd).toBeGreaterThan(0);

  const open = () => page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("vault"));
  await open();
  const vault = vaultWindow(page);
  await expect(vault.getByRole("row", { name: /USD/ })).toBeVisible({ timeout: 20_000 });
  /* No floor set: no currency is Low stock, however little is held. */
  await expect(vault.getByText("Low stock")).toHaveCount(0);

  /* The owner sets a USD floor above what the safe holds. */
  await page.evaluate(() => (window as unknown as { CDOS: { openSettingsTab: (t: string) => void } }).CDOS.openSettingsTab("vault"));
  const settings = page.locator(".win", { hasText: "Per-currency low-stock floor" });
  const floor = settings.locator("div").filter({ hasText: /^USD$/ }).getByRole("spinbutton");
  await expect(floor).toBeVisible();
  try {
    await floor.fill(String(Math.ceil(usd) + 1000));
    await open();
    await expect(vault.getByRole("row", { name: /USD/ }).getByText("Low stock")).toBeVisible();
    await expect(vault.getByText("Low stock")).toHaveCount(1);
  } finally {
    /* The floor is this session's only; cleared all the same. */
    await floor.fill("");
  }
  await expect(vault.getByText("Low stock")).toHaveCount(0);
});
