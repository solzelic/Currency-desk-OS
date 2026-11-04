/* Rates v2.5: one set of opening hours, contact details and logo for the shop.

   The rate page editor and Settings (Business profile) edit the same
   business profile. Hours by day are the source: the rate page says open
   or closed from them, and the storefront's Visit page shows the lines the
   server makes from them. An owner's change in either place shows in the
   other. A change a manager makes on the rate page is offered to the owner
   in Settings, and Settings asks before publishing over it. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(u as string, b ? { method: m as string, headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : { method: m as string });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, url, body] as const);
const CLOSED_WEEK = [null, null, null, null, null, null, null];

async function openDesk(page: Page, staffId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, staffId);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
const openApp = (page: Page, id: string) =>
  page.evaluate((app) => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp(app), id);

test("a week set on the rate page shows in Settings, and Settings publishes it back to the page and the storefront", async ({ page }) => {
  await openDesk(page, "j.masri");
  await api(page, "GET", "/api/rate-page");
  expect((await api(page, "PATCH", "/api/rate-page/content", { profile: { week: CLOSED_WEEK } })).status).toBe(200);
  await page.reload();
  await openDesk(page, "j.masri");

  await openApp(page, "rates");
  await page.getByRole("tab", { name: "Website & window" }).click();
  await page.getByRole("region", { name: "Rate page" }).getByRole("button", { name: "Edit" }).click();
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/rate-page/content") && r.request().method() === "PATCH");
  await page.getByRole("region", { name: "Opening hours" }).getByRole("switch", { name: "Open on Monday" }).click();
  expect((await saved).status()).toBe(200);

  await openApp(page, "settings");
  const hours = page.getByRole("group", { name: "Opening hours by day" });
  await expect(hours.getByRole("switch", { name: "Open on Monday" })).toHaveAttribute("aria-checked", "true");
  await expect(hours.getByRole("switch", { name: "Open on Tuesday" })).toHaveAttribute("aria-checked", "false");

  await hours.getByRole("switch", { name: "Open on Tuesday" }).click();
  const published = page.waitForResponse((r) => r.url().endsWith("/api/tenant") && r.request().method() === "PATCH");
  await page.getByRole("button", { name: /Publish contact & hours/ }).click();
  expect((await published).status()).toBe(200);
  const profile = (await api(page, "GET", "/api/rate-page")).body.profile;
  expect(profile.week[2]).toEqual([9.5, 18]);
  expect(profile.hours[0]).toEqual({ days: "Mon to Tue", hours: "9:30 am to 6 pm" });
});

test("a manager's change on the rate page is offered to the owner in Settings, and not published over without asking", async ({ page, browser }) => {
  /* The owner's desk is open on Business profile. */
  await openDesk(page, "j.masri");
  await openApp(page, "settings");
  await expect(page.getByRole("group", { name: "Opening hours by day" })).toBeVisible();

  /* Meanwhile a manager, at another desk, changes the phone on the rate page. */
  const other = await (await browser.newContext()).newPage();
  await signInAtDesk(other, "r.haddad");
  expect((await api(other, "PATCH", "/api/rate-page/content", { profile: { phone: "+1 416 555 0199" } })).status).toBe(200);
  await other.close();

  /* Opening Business profile again reads what was published. */
  await page.getByRole("button", { name: /My account/ }).click();
  await page.getByRole("button", { name: "Business profile" }).click();
  const notice = page.getByRole("status").filter({ hasText: "Your rate page has newer contact details or hours" });
  await expect(notice).toBeVisible();

  /* Publishing first asks; saying no leaves the page as the manager left it. */
  page.once("dialog", (d) => d.dismiss());
  await page.getByRole("button", { name: /Publish contact & hours/ }).click();
  expect((await api(page, "GET", "/api/rate-page")).body.profile.phone).toBe("+1 416 555 0199");

  await notice.getByRole("button", { name: "Use the published details" }).click();
  await expect(page.getByLabel("Phone")).toHaveValue("+1 416 555 0199");
  await expect(notice).toBeHidden();
});

test("the rate page takes the logo the desk already has", async ({ page }) => {
  await openDesk(page, "j.masri");
  /* A logo set in Settings → Business profile. */
  await openApp(page, "settings");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.locator('input[type="file"][accept="image/*"]').first().setInputFiles({ name: "desk.png", mimeType: "image/png", buffer: PNG });
  await expect(page.locator('img[alt="logo"]').first()).toBeVisible();

  await openApp(page, "rates");
  await page.getByRole("tab", { name: "Website & window" }).click();
  await page.getByRole("region", { name: "Rate page" }).getByRole("button", { name: "Edit" }).click();
  const sent = page.waitForResponse((r) => r.url().endsWith("/api/rate-page/logo") && r.request().method() === "PUT");
  await page.getByRole("button", { name: "Use your desk logo" }).click();
  expect((await sent).status()).toBe(200);
  expect((await api(page, "GET", "/api/rate-page")).body.logo).toMatch(/^\/api\/rate-page\/logo\?v=\d+$/);
});
