import { expect, test } from "@playwright/test";

async function openDesk(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId("signin-a.singh").click();
  await expect(page.getByRole("heading", { name: "Yorkville Desk" })).toBeVisible();
}

test("matches the original-style desktop default state", async ({ page }) => {
  await openDesk(page);
  await expect(page.locator(".os-workspace")).toHaveScreenshot("desktop-shell.png", { animations: "disabled" });
});

test("matches the Exchange Desk initial state", async ({ page }) => {
  await openDesk(page);
  await expect(page.locator(".os-window").filter({ hasText: "Currency exchange" })).toHaveScreenshot("exchange-desk-initial.png", { animations: "disabled" });
});

test("matches the Exchange Desk customer-selected state", async ({ page }) => {
  await openDesk(page);
  await page.getByTestId("new-customer-name").fill("Visual Desk Customer");
  await page.getByTestId("create-customer").click();
  await expect(page.getByTestId("selected-customer")).toContainText("Visual Desk Customer");
  await expect(page.locator(".os-window").filter({ hasText: "Currency exchange" })).toHaveScreenshot("exchange-desk-customer-selected.png", { animations: "disabled" });
});

test("matches a completed transaction desktop state", async ({ page }) => {
  await openDesk(page);
  await page.getByTestId("new-customer-name").fill("Visual Posted Customer");
  await page.getByTestId("create-customer").click();
  await page.getByTestId("input-amount").fill("1000");
  await page.getByTestId("fee-cad").fill("4");
  await page.getByTestId("post-transaction").click();
  await expect(page.getByTestId("receipt")).toContainText("Receipt CD-");
  await expect(page.locator(".os-workspace")).toHaveScreenshot("completed-transaction.png", { animations: "disabled" });
});

test("matches the multi-window state", async ({ page }) => {
  await openDesk(page);
  await page.getByTestId("open-ledger").click();
  await page.getByTestId("open-till").click();
  await page.getByTestId("open-clients").click();
  await expect(page.locator(".os-workspace")).toHaveScreenshot("multi-window.png", { animations: "disabled" });
});

test("matches the minimized and restored window state", async ({ page }) => {
  await openDesk(page);
  await page.getByTestId("open-ledger").click();
  await expect(page.getByRole("button", { name: "Minimize Ledger" })).toBeVisible();
  await page.getByRole("button", { name: "Minimize Ledger" }).click();
  await expect(page.getByRole("button", { name: "Minimize Ledger" })).toBeHidden();
  await expect(page.locator(".os-workspace")).toHaveScreenshot("minimized-window.png", { animations: "disabled" });

  await page.getByTestId("open-ledger").click();
  await expect(page.getByRole("button", { name: "Focus Ledger" })).toBeVisible();
  await page.getByRole("button", { name: "Close Ledger" }).click();
  await expect(page.getByRole("button", { name: "Close Ledger" })).toHaveCount(0);

  await page.getByTestId("open-ledger").click();
  await expect(page.getByRole("button", { name: "Focus Ledger" })).toBeVisible();
});
