import { expect, test } from "@playwright/test";

test("posts the full currency exchange vertical slice", async ({ page }) => {
  await page.goto("/frontend.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByTestId("signin-a.singh").click();
  await expect(page.getByRole("heading", { name: "Yorkville Desk" })).toBeVisible();

  await page.getByTestId("new-customer-name").fill("E2E Verified Client");
  await page.getByTestId("create-customer").click();
  await expect(page.getByTestId("selected-customer")).toContainText("E2E Verified Client");

  await page.getByTestId("input-amount").fill("1000");
  await page.getByTestId("fee-cad").fill("4");
  await expect(page.getByTestId("quote-box")).toContainText("US$724.42");
  await expect(page.getByTestId("compliance-checks")).toContainText("No enhanced review required.");

  await page.getByTestId("post-transaction").click();

  await expect(page.getByText(/Posted CD-/)).toBeVisible();
  await expect(page.getByTestId("ledger-list")).toContainText("E2E Verified Client");
  await expect(page.getByTestId("receipt")).toContainText("Receipt CD-");
  await expect(page.getByTestId("receipt")).toContainText("Received: US$724.42");
  await expect(page.getByTestId("till-summary")).toContainText("CAD$26,000.00");
  await expect(page.getByTestId("till-summary")).toContainText("US$11,275.58");
});
