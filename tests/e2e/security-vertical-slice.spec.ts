import { expect, test } from "@playwright/test";

test("posts the existing vertical slice through scoped demo persistence", async ({ page }) => {
  await page.goto("/frontend.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  await page.getByTestId("signin-a.singh").click();
  await expect(page.getByRole("heading", { name: "Yorkville Desk" })).toBeVisible();

  await page.getByTestId("new-customer-name").fill("Security E2E Customer");
  await page.getByTestId("create-customer").click();
  await expect(page.getByTestId("selected-customer")).toContainText("Security E2E Customer");

  await page.getByTestId("input-amount").fill("1000");
  await page.getByTestId("fee-cad").fill("4");
  await expect(page.getByTestId("quote-box")).toContainText("US$724.42");
  await page.getByTestId("post-transaction").click();

  await expect(page.getByText(/Posted CD-/)).toBeVisible();
  await expect(page.getByTestId("ledger-list")).toContainText("Security E2E Customer");
  await expect(page.getByTestId("receipt")).toContainText("Received: US$724.42");
  await expect(page.getByTestId("till-summary")).toContainText("US$11,275.58");

  const auditActions = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.endsWith(":audit"));
    return key ? JSON.parse(localStorage.getItem(key) ?? "[]").map((event: { action: string }) => event.action) : [];
  });
  expect(auditActions).toEqual(["session.sign_in", "customer.create", "transaction.post"]);
});
