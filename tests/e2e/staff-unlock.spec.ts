/* Unlock sits on the staff row for an owner. The click asks a plain
   question, then posts to the existing unlock route. A teller does
   not get the button. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
}

async function openEmployees(page: Page): Promise<void> {
  const phone = page.locator("#phonebar");
  if (await phone.isVisible()) {
    const tab = page.locator('#phonebar [data-phone-app="settings"]');
    if (await tab.count()) await tab.click();
    else {
      const sheet = page.locator("#phone-more");
      if (!(await sheet.isVisible())) await page.locator('#phonebar [data-phone-app="more"]').click();
      await page.locator('#phone-more [data-phone-app="settings"]').click();
    }
  } else {
    await page.locator('[data-app="settings"]').click();
  }
  await expect(page.locator(".win.show.active").first()).toBeVisible();
  await dismissTour(page);
  await page.getByRole("button", { name: "Employees" }).click();
}

test.describe("staff row unlock", () => {
  for (const width of [360, 390]) {
    test(`owner unlock is at least 44px at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 360 ? 780 : 844 });
      await signInAtDesk(page, "j.masri");
      await dismissTour(page);
      await openEmployees(page);
      const unlock = page.getByRole("button", { name: "Unlock" }).first();
      await expect(unlock).toBeVisible();
      const box = await unlock.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    });
  }

  test("confirm posts to the existing unlock route", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAtDesk(page, "j.masri");
    await dismissTour(page);
    await openEmployees(page);
    const profile = page.getByRole("button", { name: /M\. Costa/ });
    const unlock = profile.locator("xpath=..").getByRole("button", { name: "Unlock" });
    await expect(unlock).toBeVisible();
    page.once("dialog", (dialog) => {
      expect(dialog.message()).toBe("Unlock M. Costa? They can try their password again.");
      return dialog.accept();
    });
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/login/unlock") && r.request().method() === "POST"),
      unlock.click(),
    ]);
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ staffId: "m.costa" });
  });

  test("a teller does not see Unlock", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAtDesk(page, "m.costa");
    await dismissTour(page);
    const more = page.locator('#phonebar [data-phone-app="more"]');
    if (await more.isVisible()) {
      await more.click();
      const settings = page.locator('#phone-more [data-phone-app="settings"]');
      if (await settings.count()) {
        await settings.click();
        await dismissTour(page);
        const employees = page.getByRole("button", { name: "Employees" });
        if (await employees.count()) await employees.click();
      }
    }
    await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  });
});
