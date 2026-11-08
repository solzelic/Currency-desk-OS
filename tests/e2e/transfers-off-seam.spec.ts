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
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, codeFor, logSize } from "./fixtures";

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

test("direct signup enters a real desk with Transfers off, without a reload", async ({ page }) => {
  const stamp = Date.now();
  const email = `owner-${stamp}@transfer-signup.example`;
  const slug = `transfer${stamp}`;
  // hasLedger above ensures this is the disposable seam database.
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      "INSERT INTO enquiries (id, reference, kind, email, name, status) VALUES ($1, $2, 'early_access', $3, $4, 'invited')",
      [`enq-transfer-${stamp}`, `CD-T${String(stamp).slice(-6)}`, email, "Transfer Owner"],
    );
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/app?signup=1");
    await page.getByRole("button", { name: /Canada.*FINTRAC/ }).click();
    const next = page.getByRole("button", { name: "Continue →", exact: true });
    await next.click();
    await page.getByPlaceholder("Maple Currency Exchange").fill("Transfer Signup");
    await next.click();
    await page.getByPlaceholder("Dana Kim").fill("Transfer Owner");
    await page.getByPlaceholder("you@business.com").fill(email);
    await page.getByPlaceholder("at least 8 characters", { exact: true }).fill("transfer-signup-2026");
    await page.getByPlaceholder("maplefx", { exact: true }).fill(slug);
    await next.click();
    await next.click();
    await next.click();
    const before = logSize();
    await page.getByRole("button", { name: "Create my desk →", exact: true }).click();
    await page.getByPlaceholder("000000").fill(await codeFor(email, before));
    const response = page.waitForResponse((r) => r.url().endsWith("/api/signup/verify") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Verify & open my desk →", exact: true }).click();
    expect((await (await response).json()).user.transfersAvailable).toBe(false);
    await page.getByRole("button", { name: "Enter CurrencyDesk →", exact: true }).click();
    await landOnDesktop(page);
    await expect(page.locator("#appbar .app-btn[data-app='ledger']")).toBeVisible();
    await expect(page.locator("#appbar .app-btn[data-app='transfers']")).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("transfers"));
    await expect(page.getByRole("status").filter({ hasText: NOTE }).first()).toBeVisible();
  } finally {
    await pool.end();
  }
});

test("same-user focus refresh updates transfer availability in both directions", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  const tenantId = await tenantOf(page);
  // hasLedger above ensures this is the disposable seam database.
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    for (const on of [false, true]) {
      await pool.query("UPDATE tenants SET is_test_shop = $1 WHERE id = $2", [on, tenantId]);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(page.locator("#appbar .app-btn[data-app='transfers']")).toHaveCount(on ? 1 : 0);
    }
  } finally {
    await pool.query("UPDATE tenants SET is_test_shop = true WHERE id = $1", [tenantId]);
    await pool.end();
  }
});

test("already-open Compliance follows capability refresh without losing stored transfers", async ({ page }) => {
  await signInAtDesk(page, "j.masri");
  const tenantId = await tenantOf(page);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const saved = await page.evaluate(() => {
    const key = "cdos_transfers_v1";
    const before = localStorage.getItem(key);
    const cdos = (window as unknown as { CDOS: { TODAY: string; openApp: (id: string) => void } }).CDOS;
    const stored = JSON.stringify([1, 2].map(n => ({
      id: `capability-${n}`, ref: `TR-CAPABILITY-${n}`, date: cdos.TODAY, time: `10:0${n}`,
      direction: "send", payAmt: 6000, ccy: "CAD", status: "sent",
      senderName: "Capability Refresh Person", partner: "Synthetic Partner",
    })));
    localStorage.setItem(key, stored);
    cdos.openApp("compliance");
    return { before, stored };
  });
  const compliance = page.locator('.win-body[data-screen-label="Compliance"]');
  const refresh = async (on: boolean) => {
    await pool.query("UPDATE tenants SET is_test_shop = $1 WHERE id = $2", [on, tenantId]);
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator("#appbar .app-btn[data-app='transfers']")).toHaveCount(on ? 1 : 0);
  };
  try {
    for (const tab of ["Aggregation", "Filings"]) {
      await refresh(true);
      await compliance.locator(".fld-tab").filter({ hasText: new RegExp(tab, "i") }).click();
      const actions = tab === "Aggregation"
        ? compliance.getByRole("button", { name: /File EFTR/ })
        : compliance.locator("div.flex.items-center.gap-3").filter({ hasText: "Capability Refresh Person" }).getByRole("button", { name: "Open worksheet" });
      await expect(actions).toHaveCount(1);
      const reports = compliance.getByRole("button", { name: /Reports to file/ }).locator(".font-bold");
      const enabledCount = Number(await reports.textContent());
      for (const on of [false, true, false]) {
        await refresh(on);
        await expect(actions).toHaveCount(on ? 1 : 0);
        await expect(reports).toHaveText(String(enabledCount - (on ? 0 : 1)));
        expect(await page.evaluate(() => localStorage.getItem("cdos_transfers_v1"))).toBe(saved.stored);
      }
    }
    // Keep a fully typed, not-yet-filed worksheet open across revocation.
    await refresh(true);
    await compliance.locator(".fld-tab").filter({ hasText: /aggregation/i }).click();
    await compliance.getByRole("button", { name: /File EFTR/ }).click();
    const worksheet = page.locator(".fixed.inset-0").filter({ hasText: "FILING WORKSHEET" });
    for (const input of await worksheet.locator("input, textarea").all()) await input.fill("Synthetic field");
    await worksheet.getByRole("button", { name: "Mark filed & seal" }).click();
    const receipt = worksheet.getByPlaceholder(/receipt number/);
    await receipt.fill("SYNTHETIC-CAPABILITY-RECEIPT");
    const seal = worksheet.getByRole("button", { name: "Seal filed copy" });
    await expect(seal).toBeEnabled();
    await refresh(false);
    await expect(worksheet.getByRole("status")).toContainText("This unfinished worksheet is kept here, but cannot be filed.");
    await expect(seal).toBeDisabled();
    await expect(receipt).toHaveValue("SYNTHETIC-CAPABILITY-RECEIPT");
    await refresh(true);
    await expect(worksheet.getByRole("status")).toHaveCount(0);
    await expect(seal).toBeEnabled();
    await expect(receipt).toHaveValue("SYNTHETIC-CAPABILITY-RECEIPT");
  } finally {
    await pool.query("UPDATE tenants SET is_test_shop = true WHERE id = $1", [tenantId]);
    await pool.end();
    await page.evaluate(before => {
      if (before === null) localStorage.removeItem("cdos_transfers_v1");
      else localStorage.setItem("cdos_transfers_v1", before);
      document.dispatchEvent(new Event("visibilitychange"));
    }, saved.before);
  }
});

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
