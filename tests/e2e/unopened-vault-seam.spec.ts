/* ============================================================
   A float from a vault nobody has counted.

   The till used to go up by the amount, and the vault — which had
   no row — went down by nothing. The screen has to show the refusal,
   and the book has to be unchanged.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import { mkdirSync } from "node:fs";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

test("taking cash from an unopened vault is refused, on screen and in the book", async ({ page }) => {
  await signInAtDesk(page);
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

  mkdirSync("/opt/cursor/artifacts/money-fixes", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: "/opt/cursor/artifacts/money-fixes/vault-not-open-1280.png",
  });
});

test("the unopened-vault refusal is readable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page);
  const book = ledger(page);
  expect((await book.vault()).tracked).toBe(false);

  await page.getByText(/Cash Drawer/i).first().click();
  const openTill = page.getByRole("button", { name: /Open the till/i }).first();
  if (await openTill.isVisible().catch(() => false)) await openTill.click();
  await page.getByRole("button", { name: /^Move cash$/i }).first().click();
  await page.locator('input[placeholder="0"]').last().fill("50");
  await page.getByRole("button", { name: /Issue float/i }).last().click();
  await expect(page.getByText("Open the vault with a starting count first.")).toBeVisible();

  mkdirSync("/opt/cursor/artifacts/money-fixes", { recursive: true });
  await page.screenshot({
    path: "/opt/cursor/artifacts/money-fixes/vault-not-open-390.png",
  });
});
