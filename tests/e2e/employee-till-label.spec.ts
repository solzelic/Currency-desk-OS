/* A staff row with no drawer used to say "unposted". The chip is
   "No till": the person is not posted to a till. Someone who is
   posted still shows that till's name. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function openEmployees(page: Page): Promise<void> {
  const phone = page.locator("#phonebar");
  if (await phone.isVisible()) {
    const sheet = page.locator("#phone-more");
    if (!(await sheet.isVisible())) await page.locator('#phonebar [data-phone-app="more"]').click();
    await page.locator('#phone-more [data-phone-app="settings"]').click();
  } else {
    await page.locator('[data-app="settings"]').click();
  }
  await dismissTour(page);
  const employees = page.getByRole("button", { name: "Employees" });
  await expect(employees).toBeVisible();
  await employees.click();
  await expect(page.getByRole("button", { name: /J\. Masri/ })).toBeVisible();
}

async function expectTillLabels(page: Page): Promise<void> {
  const masri = page.getByRole("button", { name: /J\. Masri/ });
  const iqbal = page.getByRole("button", { name: /S\. Iqbal/ });
  const costa = page.getByRole("button", { name: /M\. Costa/ });
  await iqbal.scrollIntoViewIfNeeded();
  await expect(masri).toContainText("No till");
  await expect(iqbal).toContainText("No till");
  await expect(masri).not.toContainText("unposted");
  await expect(iqbal).not.toContainText("unposted");
  await expect(costa).toContainText("Till 2");
  await expect(costa).not.toContainText("No till");
  await expect(page.locator("body")).not.toContainText("unposted");
}

test("rows with no drawer say No till at 390", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page, "r.haddad");
  await dismissTour(page);
  await openEmployees(page);
  await page.getByRole("button", { name: /J\. Masri/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/cursor/stores/self/notill/roster_390.png" });
  await expectTillLabels(page);
  await page.screenshot({ path: "/cursor/stores/self/notill/roster_390_iqbal.png" });
});

test("rows with no drawer say No till at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "r.haddad");
  await dismissTour(page);
  await openEmployees(page);
  await expectTillLabels(page);
  await page.screenshot({ path: "/cursor/stores/self/notill/roster_1280.png" });
});
