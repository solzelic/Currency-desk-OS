/* Unlock sits on a locked colleague's row. A teller who can see that
   row still has no Unlock. A manager who is missing it fails this
   file. The confirm is a sheet in the desk, and a success drops the
   Locked tag without a reload. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

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
  await dismissTour(page);
  const employees = page.getByRole("button", { name: "Employees" });
  await expect(employees).toBeVisible();
  await employees.click();
  await expect(page.getByRole("button", { name: /M\. Costa|J\. Masri/ }).first()).toBeVisible();
}

async function ensureLocked(page: Page, staffId: string): Promise<void> {
  const once = () => page.request.post("/api/auth/login/start", {
    data: { staffId, password: "wrong-password-lock", tenantId: "tnt-yorkfx" },
  });
  let res = await once();
  if (res.status() === 429) return;
  for (let n = 0; n < 5 && res.status() !== 429; n++) res = await once();
  expect(res.status()).toBe(429);
}

test.describe("staff row unlock", () => {
  test("a teller does not see Unlock on a locked colleague", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAtDesk(page, "m.costa");
    await dismissTour(page);
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
      const employees = (raw.employees || []).map((employee: { code?: string; caps?: Record<string, boolean> }) =>
        employee.code === "m.costa" ? { ...employee, caps: { ...(employee.caps || {}), canSettings: true } } : employee);
      localStorage.setItem("cdos_settings", JSON.stringify({ ...raw, employees }));
    });
    await page.route("**/api/staff", (route) => {
      if (route.request().method() !== "GET") return route.continue();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          staff: [
            { staffId: "m.costa", name: "M. Costa", role: "teller", active: true, lockedUntil: null },
            { staffId: "j.masri", name: "J. Masri", role: "administrator", active: true, lockedUntil: "5:04 AM" },
          ],
        }),
      });
    });
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
    await openEmployees(page);
    await expect(page.getByText("J. Masri").first()).toBeVisible();
    await expect(page.getByText("Locked until 5:04 AM").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  });

  test("a manager sees Unlock only on a locked colleague", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureLocked(page, "m.costa");
    await signInAtDesk(page, "r.haddad");
    await dismissTour(page);
    await openEmployees(page);
    const costa = page.getByRole("button", { name: /M\. Costa/ });
    const unlock = costa.locator("xpath=..").getByRole("button", { name: "Unlock" });
    await expect(unlock).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(1);
    const box = await unlock.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const paint = await unlock.evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, border: style.borderTopWidth };
    });
    expect(paint.background === "rgba(0, 0, 0, 0)" || paint.background === "transparent").toBe(true);
    expect(Number.parseFloat(paint.border)).toBeGreaterThan(0);
    const tag = page.getByText(/Locked until \d{1,2}:\d{2} (AM|PM)/).first();
    await expect(tag).toBeVisible();
    expect(await tag.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(192, 57, 43)");
    await expect(page.getByRole("button", { name: /R\. Haddad/ }).locator("xpath=..").getByRole("button", { name: "Unlock" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /J\. Masri/ }).locator("xpath=..").getByRole("button", { name: "Unlock" })).toHaveCount(0);

    await unlock.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Unlock M. Costa?")).toBeVisible();
    await sheet.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("M. Costa can sign in again.")).toBeVisible();
    await expect(page.getByText(/Locked until/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unlock" })).toHaveCount(0);
  });

  test("a failed unlock stays in the shop's words", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await ensureLocked(page, "m.costa");
    await signInAtDesk(page, "r.haddad");
    await dismissTour(page);
    await page.route("**/api/auth/login/unlock", (route) => route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "not_found" }),
    }));
    await openEmployees(page);
    await page.getByRole("button", { name: /M\. Costa/ }).locator("xpath=..").getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("That person is not on this desk.")).toBeVisible();
    await expect(page.getByText(/Locked until/)).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/HTTP|not_found|unauthenticated|Failed to fetch/);

    await page.unroute("**/api/auth/login/unlock");
    await page.route("**/api/auth/login/unlock", (route) => route.abort());
    await page.getByRole("button", { name: /M\. Costa/ }).locator("xpath=..").getByRole("button", { name: "Unlock" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("The desk could not be reached. Try again in a moment.")).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(/HTTP|not_found|unauthenticated|Failed to fetch/);
  });

  test("an owner does not unlock their own locked row", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAtDesk(page, "j.masri");
    await dismissTour(page);
    await ensureLocked(page, "j.masri");
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
    await openEmployees(page);
    const mine = page.getByRole("button", { name: /J\. Masri/ });
    await expect(mine.locator("xpath=..").getByText(/Locked until/)).toBeVisible();
    await expect(mine.locator("xpath=..").getByRole("button", { name: "Unlock" })).toHaveCount(0);
  });
});
