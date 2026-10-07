/* A phone has no spare desktop. At 390 and 360 the sign-in card and
   the key desk screens have to stay inside the viewport. A table may
   scroll inside its own card. The page itself may not grow sideways.
   Tagged is a separate fix and is not opened here. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const SCREENS = ["rates", "ledger", "clients", "till", "compliance"] as const;

async function overflowPast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const seen: string[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || rect.right <= limit) continue;
      let node: HTMLElement | null = el.parentElement;
      let contained = false;
      while (node && node !== document.body && node !== document.documentElement) {
        const parent = getComputedStyle(node);
        const clips = parent.overflowX === "auto" || parent.overflowX === "scroll" || parent.overflowX === "hidden";
        if (clips && node.getBoundingClientRect().right <= limit) {
          contained = true;
          break;
        }
        node = node.parentElement;
      }
      if (contained) continue;
      const name = (el.id ? "#" + el.id : el.tagName.toLowerCase()) + "." + String(el.className).slice(0, 48);
      seen.push(name + " right=" + Math.round(rect.right));
      if (seen.length >= 6) break;
    }
    return seen;
  });
}

test("key desk screens stay inside a phone width", async ({ page }) => {
  test.setTimeout(150_000);
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.context().clearCookies();
    await page.goto("/app");
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.reload();
    await expect(page.locator("#lock")).toBeVisible();
    expect(await overflowPast(page), `sign-in at ${width}px`).toEqual([]);

    await signInAtDesk(page);
    for (const id of SCREENS) {
      const button = page.locator(`[data-app="${id}"]`);
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(page.locator(".win.show").first()).toBeVisible();
      expect(await overflowPast(page), `${id} at ${width}px`).toEqual([]);
    }
    await page.locator('button[title="Settings"]').click();
    await expect(page.locator(".win.show").first()).toBeVisible();
    expect(await overflowPast(page), `settings at ${width}px`).toEqual([]);
  }
});
