/* Rates v2.5, the Website & window tab in the design's look: two tiles
   with live previews, the rate page editor and the window screens page.
   Every shop already has a private rate page. The owner takes it live and
   holds the address and the regulator block; a manager edits the page
   and runs the screens; a teller sees it all and changes nothing. The
   server decides who may; the tab only shows each person what they can
   do. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });
const SLUG = "e2e-site-tab";

const api = (page: Page, method: string, url: string, body?: unknown) => page.evaluate(async ([m, u, b]) => {
  const res = await fetch(u as string, b ? { method: m as string, headers: { "content-type": "application/json" }, body: JSON.stringify(b) } : { method: m as string });
  return { status: res.status, body: await res.json().catch(() => null) };
}, [method, url, body] as const);

async function openTab(page: Page, staffId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, staffId);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await page.getByRole("tab", { name: "Website & window" }).click();
  await expect(page.getByRole("region", { name: "Rate page" })).toBeVisible({ timeout: 30_000 });
}
const saved = (page: Page) => page.waitForResponse((r) => r.url().endsWith("/api/rate-page/content") && r.request().method() === "PATCH");

test("the owner edits the private page, sees it in the preview, names it and takes it live", async ({ page, browser }) => {
  await signInAtDesk(page, "j.masri");
  /* Other files share this seed shop: start from a private page with nothing written. */
  await api(page, "GET", "/api/rate-page");
  await api(page, "PUT", "/api/rate-page", { live: false });
  await api(page, "PATCH", "/api/rate-page/content", { tagline: "" });
  await openTab(page, "j.masri");

  const tile = page.getByRole("region", { name: "Rate page" });
  await expect(tile).toContainText("Private");
  await tile.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Your online rate page" })).toBeVisible();

  const line = page.getByRole("region", { name: "Your brand" }).getByPlaceholder("e.g. Best rates in town since 2009");
  const tagline = saved(page);
  await line.fill("Fair rates since 2009");
  expect((await tagline).status()).toBe(200);
  const monday = saved(page);
  await page.getByRole("switch", { name: "Open on Monday" }).click();
  expect((await monday).status()).toBe(200);
  /* The preview is the page itself, before it is live. */
  const preview = page.frameLocator('iframe[title="Rate page preview"]');
  await expect(preview.locator("#tagline")).toHaveText("Fair rates since 2009");
  await expect(preview.locator("#open-line")).toBeVisible();

  /* The logo: any picture, drawn to a 240px PNG by the desk. */
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const logo = page.waitForResponse((r) => r.url().endsWith("/api/rate-page/logo") && r.request().method() === "PUT");
  await page.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG });
  expect((await logo).status()).toBe(200);
  await expect(page.getByRole("region", { name: "Your brand" }).getByRole("button", { name: "Remove", exact: true })).toBeVisible();
  await expect(preview.locator("#mark img")).toHaveAttribute("src", /^\/api\/rate-page\/logo\?v=\d+$/);

  /* The owner holds the address and the switch. */
  await page.getByLabel("Page address").fill(SLUG);
  await page.getByRole("button", { name: "Save address" }).click();
  await expect(page.getByRole("button", { name: "Save address" })).toBeDisabled();
  const stranger = await (await browser.newContext()).newPage();
  expect((await stranger.goto(`/r/${SLUG}`))?.status()).toBe(200);
  await expect(stranger.getByText("This rate page is not available.")).toBeVisible();
  await page.getByRole("switch", { name: "Rate page live" }).click();
  await expect(page.getByText("Live. Anyone with the link sees your published rates.")).toBeVisible();
  await stranger.reload();
  await expect(stranger.locator("#tagline")).toHaveText("Fair rates since 2009");
  await expect(stranger.locator("[data-code]").first()).toBeVisible();
  await expect(stranger.locator("#mark img")).toHaveAttribute("src", new RegExp(`^/api/public/rate-pages/${SLUG}/logo\\?v=\\d+$`));
  await stranger.close();
});

test("a manager edits the page and runs the screens, but not the address, the switch or the regulator", async ({ page }) => {
  await openTab(page, "r.haddad");
  await page.getByRole("region", { name: "Rate page" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("switch", { name: "Rate page live" })).toBeDisabled();
  await expect(page.getByLabel("Page address")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Always on your page" }).getByRole("textbox").first()).toBeDisabled();
  await expect(page.getByText("Only the owner changes these")).toBeVisible();

  await page.getByRole("button", { name: "Website & window" }).click();
  /* The tile adds the first screen; with screens already there it opens
     the screens page, where Add a screen makes one more. Exactly one is
     added either way. */
  const go = page.getByRole("region", { name: "Window screens" }).getByRole("button", { name: /Add a screen|Set up/ });
  const first = (await go.textContent())?.includes("Add a screen");
  await go.click();
  if (!first) await page.getByRole("button", { name: "Add a screen" }).click();
  const setup = page.getByRole("region", { name: "Screen setup" });
  await expect(setup.getByLabel("Screen name")).toHaveValue(/^Screen \d+$/);
  const renamed = page.waitForResponse((r) => /\/api\/window-screens\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH" && (r.request().postData() ?? "").includes("Counter tablet"));
  await setup.getByLabel("Screen name").fill("Counter tablet");
  expect((await renamed).status()).toBe(200);
  await expect(page.getByRole("list", { name: "Your screens" })).toContainText("Counter tablet");

  /* The design's other screens and options: a strip ticker without flags. */
  await setup.getByRole("button", { name: /Strip above the counter/ }).click();
  const flagsOff = page.waitForResponse((r) => /\/api\/window-screens\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH" && (r.request().postData() ?? "").includes('"flags":false'));
  await setup.getByRole("button", { name: "Flags", exact: true }).click();
  expect((await flagsOff).status()).toBe(200);
  await expect(setup.getByRole("button", { name: "Flags", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.frameLocator('iframe[title="Window screen preview"]').locator("#strip")).toBeVisible();
  const strip = (await api(page, "GET", "/api/window-screens")).body.screens.find((s: { name: string }) => s.name === "Counter tablet");
  expect(strip).toMatchObject({ kind: "strip", show: { flags: false, names: true, clock: true } });
  await setup.getByRole("button", { name: /Tablet on the counter/ }).click();
  await expect(setup.getByRole("button", { name: /Tablet on the counter/ })).toHaveAttribute("aria-pressed", "true");

  /* Reset: a new link, the old one stops. */
  const before = (await api(page, "GET", "/api/window-screens")).body.screens.find((s: { name: string }) => s.name === "Counter tablet");
  await setup.getByRole("button", { name: "More" }).click();
  await setup.getByRole("button", { name: "Reset link" }).click();
  await expect(setup).not.toContainText(before.token);
  expect((await page.request.get(`/api/public/screens/${before.token}`)).status()).toBe(404);

  page.once("dialog", (d) => d.accept());
  await setup.getByRole("button", { name: "More" }).click();
  await setup.getByRole("button", { name: "Remove screen" }).click();
  await expect(page.getByRole("list", { name: "Your screens" })).not.toContainText("Counter tablet");
});

test("a teller sees the page and screens, and cannot change them", async ({ page }) => {
  await openTab(page, "m.costa");
  await page.getByRole("region", { name: "Rate page" }).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("region", { name: "Your brand" }).getByRole("textbox").first()).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Open on Monday" })).toBeDisabled();
  expect((await api(page, "PATCH", "/api/rate-page/content", { tagline: "x" })).status).toBe(403);
  expect((await api(page, "POST", "/api/window-screens", { name: "x", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true })).status).toBe(403);
});

test("shots: Website & window, the editor and the screens page, at 1440 and 390", async ({ page }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  await openTab(page, "j.masri");
  if (!(await api(page, "GET", "/api/window-screens")).body.screens.length) {
    await api(page, "POST", "/api/window-screens", { name: "Front window", kind: "tv", layout: "two", theme: "dark", currencies: [], showHours: true });
    await openTab(page, "j.masri");
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `docs/pr-shots/rates-site/site-tab-${width}.png` });
    await page.getByRole("region", { name: "Rate page" }).getByRole("button", { name: "Edit" }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `docs/pr-shots/rates-site/editor-${width}.png` });
    await page.getByRole("button", { name: "Website & window" }).click();
    await page.getByRole("region", { name: "Window screens" }).getByRole("button", { name: "Set up" }).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `docs/pr-shots/rates-site/screens-${width}.png` });
    await page.getByRole("button", { name: "Website & window" }).click();
  }
});
