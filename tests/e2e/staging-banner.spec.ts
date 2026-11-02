/* The staging bar takes its own space above the header, and an X hides it
   for ten minutes.

   The seam server is not a staging host, so the server never says
   `staging: true` here. These tests let the real /api/auth/me answer and
   change only that one flag in the browser, which is the flag the desk
   reads. On the lock screen they fire the same `cdos-staging-door` event
   the staging sign-in fires. Test (g) leaves the answer alone: that is
   the production shape, and the bar never renders. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const WORDS = "Staging. Demo data only. Never enter a real customer.";
const BAR = "#cdos-staging-banner";
const X = 'button[aria-label="Hide staging notice"]';
const TEN_MINUTES = 10 * 60_000;

async function asStaging(page: Page): Promise<void> {
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    if (response.status() !== 200) return route.fulfill({ response });
    const body = await response.json();
    return route.fulfill({ response, json: { ...body, staging: true } });
  });
}

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 10; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      return;
    }
    await page.waitForTimeout(150);
  }
}

const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });

const header = (width: number) => (width <= 430 ? ".phone-head" : "#menubar");

async function atDesk(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await asStaging(page);
  await signInAtDesk(page);
  await dismissTour(page);
  await expect(page.locator(BAR)).toBeVisible({ timeout: 20_000 });
}

for (const [width, height] of [[1280, 800], [390, 844], [360, 800]] as const) {
  test(`(a) at ${width}x${height} the header sits below the bar, which keeps every word`, async ({ page }) => {
    await atDesk(page, width, height);
    await expect(page.locator(BAR)).toContainText(WORDS);
    const bar = await box(page, BAR);
    expect(bar.top).toBe(0);
    /* The header slides down over 0.2s; measure where it settles. */
    await expect.poll(async () => (await box(page, header(width))).top, { message: "header top" }).toBeGreaterThanOrEqual(bar.bottom - 0.5);
    expect(bar.height, "bar height").toBeGreaterThanOrEqual(31.5);
    /* The words are never clipped: the text fits inside the bar. */
    const clipped = await page.locator(BAR).evaluate((el) => {
      const text = el.querySelector("[data-staging-words]") as HTMLElement | null;
      if (!text) return "no words element";
      return text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1 ? "clipped" : "";
    });
    expect(clipped).toBe("");
  });
}

test("(a) on the lock screen the sign-in sits below the bar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.locator("#lock")).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event("cdos-staging-door")));
  await expect(page.locator(BAR)).toBeVisible();
  const bar = await box(page, BAR);
  await expect.poll(async () => (await box(page, "#lock")).top, { message: "lock top" }).toBeGreaterThanOrEqual(bar.bottom - 0.5);
});

test("(b) the X is a 44 by 44 button with its name, and Tab shows a focus ring", async ({ page }) => {
  await atDesk(page, 1280, 800);
  const x = page.locator(X);
  await expect(x).toHaveCount(1);
  await expect(x).toHaveAttribute("type", "button");
  const size = await box(page, X);
  expect(size.width).toBeGreaterThanOrEqual(44);
  expect(size.height).toBeGreaterThanOrEqual(44);
  const bar = await box(page, BAR);
  expect(Math.abs(size.right - bar.right), "flush right").toBeLessThanOrEqual(0.5);
  let focused = false;
  for (let i = 0; i < 120 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await x.evaluate((el) => document.activeElement === el);
  }
  expect(focused, "Tab reaches the X").toBe(true);
  const ring = await x.evaluate((el) => {
    const s = getComputedStyle(el);
    return { visible: el.matches(":focus-visible"), style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(ring.visible).toBe(true);
  expect(ring.style).not.toBe("none");
  expect(ring.width).toBeGreaterThanOrEqual(2);
});

test("(c) the X hides the bar and the header moves to the top", async ({ page }) => {
  await atDesk(page, 1280, 800);
  await page.locator(X).click();
  await expect(page.locator(BAR)).toBeHidden();
  await expect.poll(async () => (await box(page, "#menubar")).top).toBe(0);
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cdos-banner").trim())).toBe("0px");
});

test("(d) ten minutes later it stays hidden until the screen changes", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-02T15:00:00Z") });
  await atDesk(page, 1280, 800);
  await page.locator(X).click();
  await expect(page.locator(BAR)).toBeHidden();
  await page.clock.fastForward(TEN_MINUTES);
  await page.waitForTimeout(500);
  await expect(page.locator(BAR), "no pop-in while the screen sits still").toBeHidden();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await expect(page.locator(BAR)).toBeVisible();
  const bar = await box(page, BAR);
  await expect.poll(async () => (await box(page, "#menubar")).top).toBeGreaterThanOrEqual(bar.bottom - 0.5);
});

test("(d) before ten minutes a screen change keeps it hidden", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-02T15:00:00Z") });
  await atDesk(page, 1280, 800);
  await page.locator(X).click();
  await page.clock.fastForward(TEN_MINUTES - 60_000);
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await page.waitForTimeout(300);
  await expect(page.locator(BAR)).toBeHidden();
});

test("(e) a reload before ten minutes keeps it hidden", async ({ page }) => {
  await atDesk(page, 1280, 800);
  await page.locator(X).click();
  await expect(page.locator(BAR)).toBeHidden();
  await page.reload();
  await expect(page.locator("#menubar")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800);
  await expect(page.locator(BAR)).toBeHidden();
  expect((await box(page, "#menubar")).top).toBe(0);
});

test("(f) the phone tab bar stays on the bottom edge, bar shown and hidden", async ({ page }) => {
  await atDesk(page, 390, 844);
  const dock = async () => (await box(page, "#phone-dock")).bottom;
  expect(await dock()).toBeCloseTo(844, 0);
  await page.locator(X).click();
  await expect(page.locator(BAR)).toBeHidden();
  expect(await dock()).toBeCloseTo(844, 0);
  expect((await box(page, ".phone-head")).top).toBe(0);
});

test("(g) without the staging flag the bar never renders", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await expect(page.locator("#lock")).toBeVisible();
  await expect(page.locator(BAR)).toHaveCount(0);
  await signInAtDesk(page);
  await dismissTour(page);
  await page.waitForTimeout(800);
  await expect(page.locator(BAR)).toHaveCount(0);
  expect((await box(page, "#menubar")).top).toBe(0);
});
