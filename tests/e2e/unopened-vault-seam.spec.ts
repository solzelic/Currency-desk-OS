/* ============================================================
   A float from a vault nobody has counted.

   The till used to go up by the amount, and the vault — which had
   no row — went down by nothing. The screen has to show the refusal,
   and the book has to be unchanged.

   This suite shares one book. An earlier test counts the safe,
   because a float needs a counted vault. These two take that count
   off for the refusal and put the same figures back through the
   opening endpoint.
   ============================================================ */
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params: string[]) => Promise<unknown>;
    end: () => Promise<void>;
  };
};

/** Take this branch's vault rows off, and remember the figures. */
async function holdTheVaultAside(page: Page): Promise<Record<string, string> | null> {
  const vault = await ledger(page).vault();
  if (!vault.tracked) return null;
  const who = (await page.evaluate(async () => {
    const response = await fetch("/api/auth/me");
    return response.json();
  })) as { user: { tenantId: string; legalEntityId: string; branchId: string } };
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query(
      `DELETE FROM ledger_vault_balances
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND branch_id=$3`,
      [who.user.tenantId, who.user.legalEntityId, who.user.branchId],
    );
  } finally {
    await pool.end();
  }
  return vault.balances as Record<string, string>;
}

async function putTheVaultBack(page: Page, balances: Record<string, string> | null) {
  if (!balances || Object.keys(balances).length === 0) return;
  const status = await page.evaluate(async (saved) => {
    const response = await fetch("/api/ledger/vault/opening-position", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances: saved }),
    });
    return response.status;
  }, balances);
  expect(status).toBe(201);
}

test("taking cash from an unopened vault is refused, on screen and in the book", async ({ page }, testInfo) => {
  await signInAtDesk(page);
  const saved = await holdTheVaultAside(page);
  try {
    const book = ledger(page);
    const vault = await book.vault();
    expect(vault.tracked).toBe(false);

    const opened = await page.evaluate(async () => {
      const session = await fetch("/api/ledger/till-session").then((r) => r.json());
      if (session.session?.status === "open") return "open";
      const response = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return response.ok || response.status === 409 ? "open" : `${response.status}`;
    });
    expect(opened).toBe("open");

    const before = await book.till();

    await page.getByText(/Cash Drawer/i).first().click();
    await page.getByRole("button", { name: /^Move cash$/i }).first().click();
    await page.locator('input[placeholder="0"]').last().fill("50");
    await page.getByRole("button", { name: /Issue float/i }).last().click();

    await expect(page.getByText("Open the vault with a starting count first.")).toBeVisible();
    expect(await book.till()).toEqual(before);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: testInfo.outputPath("vault-not-open-1280.png") });
  } finally {
    await putTheVaultBack(page, saved);
  }
});

test("the unopened-vault refusal is readable on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page);
  const saved = await holdTheVaultAside(page);
  try {
    const book = ledger(page);
    expect((await book.vault()).tracked).toBe(false);

    await page.getByText(/Cash Drawer/i).first().click();
    const openTill = page.getByRole("button", { name: /Open the till/i }).first();
    if (await openTill.isVisible().catch(() => false)) await openTill.click();
    await page.getByRole("button", { name: /^Move cash$/i }).first().click();
    await page.locator('input[placeholder="0"]').last().fill("50");
    await page.getByRole("button", { name: /Issue float/i }).last().click();
    await expect(page.getByText("Open the vault with a starting count first.")).toBeVisible();

    await page.screenshot({ path: testInfo.outputPath("vault-not-open-390.png") });
  } finally {
    await putTheVaultBack(page, saved);
  }
});
