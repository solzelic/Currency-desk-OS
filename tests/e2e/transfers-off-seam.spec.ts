/* ============================================================
   Transfers are off for a real shop (CD-111, GitHub #599).

   The server refuses a transfer for a real shop, and the desk says so
   instead of showing an app that cannot post: Transfers leaves the app
   bar, opening it anyway shows why, and Settings > Transfers says the
   same. The demo shop this suite walks is a test shop; this spec makes
   it a real shop for a moment and puts it back.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL: the transfer routes live on the ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params: unknown[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
};

const NOTE = "Transfers are off for this shop until transfer records are kept on the server.";

async function tenantOf(page: Page): Promise<string> {
  const me = (await page.evaluate(() => fetch("/api/auth/me").then((r) => r.json()))) as { user: { tenantId: string } };
  return me.user.tenantId;
}

test("a real shop has no Transfers app, is told why, and the server refuses the transfer", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  const tenantId = await tenantOf(page);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const testShop = (on: boolean) => pool.query("UPDATE tenants SET is_test_shop = $1 WHERE id = $2", [on, tenantId]);
  try {
    await testShop(false);
    /* The flag is read at sign-in. */
    await signInAtDesk(page, "j.masri");
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    await expect(page.locator("#appbar .app-btn[data-app='ledger']")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#appbar .app-btn[data-app='transfers']")).toHaveCount(0);

    await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("transfers"));
    await expect(page.getByRole("status").filter({ hasText: NOTE }).first()).toBeVisible();

    await page.evaluate(() => (window as unknown as { CDOS: { openSettingsTab: (t: string) => void } }).CDOS.openSettingsTab("transfers"));
    await expect(page.locator(".win", { hasText: "Cross-border reporting threshold" }).getByText(NOTE)).toBeVisible();

    /* Hiding the app alone would not pass: the server refuses the post. */
    const refused = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/remittances/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `off-${Date.now()}`, customerId: "customer-demo", reference: "off",
          principalAmount: "100.00", feeAmount: "0.00", payoutCurrency: "USD", payoutAmount: "70.00",
          corridor: "US", partner: "Wire partner", beneficiaryName: "A Beneficiary", purpose: "", sourceOfFunds: "",
        }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("TRANSFERS_NOT_AVAILABLE");
  } finally {
    await testShop(true);
    await pool.end();
  }
  /* A test shop again: the app is back. */
  await signInAtDesk(page, "j.masri");
  await expect(page.locator("#appbar .app-btn[data-app='transfers']")).toBeVisible({ timeout: 20_000 });
});
