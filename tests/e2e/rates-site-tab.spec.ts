/* Rates v2.5, the Website & window tab: where an owner names the shop's
   public rate page and takes it live, and where staff who may change rates
   make and retire window screens. The server decides who may; the tab only
   shows each person what they can do. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });
const SLUG = "e2e-site-tab";

async function openTab(page: Page, staffId: string, privatePage = false): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, staffId);
  /* Other files share this seed shop; the owner test starts from a private page. */
  if (privatePage) {
    await page.evaluate(async () => { await fetch("/api/rate-page", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ live: false }) }); });
  }
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await page.getByRole("tab", { name: "Website & window" }).click();
  await expect(page.getByRole("region", { name: "Rate page" })).toBeVisible({ timeout: 30_000 });
}

test("the owner names the rate page and takes it live, and the link opens it", async ({ page, browser }) => {
  await openTab(page, "j.masri", true);
  const card = page.getByRole("region", { name: "Rate page" });
  await card.getByLabel("Page address").fill(SLUG);
  await card.getByRole("button", { name: "Save address" }).click();
  await expect(card.getByText("Private. Nobody can open this address until you turn it on.")).toBeVisible();
  await card.getByRole("switch", { name: "Rate page live" }).click();
  await expect(card.getByText("Live. Anyone with the link sees your published rates.")).toBeVisible();
  await expect(card.getByRole("link", { name: "Open page" })).toHaveAttribute("href", `/r/${SLUG}`);
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/r/${SLUG}`);
  await expect(stranger.locator("#rates tr").first()).toBeVisible();
  await stranger.close();
});

test("a manager adds a window screen and retires it, and cannot take the page live", async ({ page }) => {
  await openTab(page, "r.haddad");
  await expect(page.getByRole("switch", { name: "Rate page live" })).toBeDisabled();
  await expect(page.getByText("Only the owner can take the rate page live.")).toBeVisible();
  const screens = page.getByRole("region", { name: "Window screens" });
  await screens.getByLabel("Screen name").fill("Counter tablet");
  await screens.getByLabel("Layout").selectOption("one");
  await screens.getByRole("button", { name: "Add screen" }).click();
  const row = screens.getByRole("listitem").filter({ hasText: "Counter tablet" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("link", { name: "Open screen" })).toHaveAttribute("href", /^\/s\/[A-Za-z0-9_-]{32}$/);
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Retire" }).click();
  await expect(screens.getByRole("listitem").filter({ hasText: "Counter tablet" })).toHaveCount(0);
});

test("a teller sees the page and screens, and cannot change them", async ({ page }) => {
  await openTab(page, "m.costa");
  await expect(page.getByRole("switch", { name: "Rate page live" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add screen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save address" })).toHaveCount(0);
});

test("shots: Website & window at 1440 and 390, light and dark", async ({ page }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  for (const theme of ["light", "dark"] as const) {
    await openTab(page, "j.masri");
    await page.evaluate((t) => (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(t), theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `docs/pr-shots/rates-site/site-tab-${width}-${theme}.png` });
    }
  }
});
