/* A phone has no spare desktop. At 390 and 360 the sign-in card and
   the key desk screens have to stay inside the viewport. A table may
   scroll inside its own card. The page itself may not grow sideways.
   Tagged is a separate fix and is not opened here.

   overflow:hidden cuts the content off. It is not a place to scroll.
   Only overflow auto or scroll counts as containment, and only when
   that box itself sits inside the screen. A button, link, input, or
   select that sticks out of a hidden ancestor is still cut off, so
   the check fails. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const SCREENS = ["rates", "ledger", "clients", "till", "compliance"] as const;

async function overflowPast(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth + 1;
    const seen: string[] = [];
    const interactive = "button, a, input, select";
    for (const el of document.body.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      const isControl = el.matches(interactive);
      let node: HTMLElement | null = el.parentElement;
      let contained = false;
      let clipped = false;
      // A hidden box between this element and a scroller cuts it off.
      // The scroller further out cannot bring it back.
      let cutOff = false;
      while (node && node !== document.body && node !== document.documentElement) {
        const parent = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const outside = rect.right > box.right + 1 || rect.left < box.left - 1;
        if (parent.overflowX === "hidden" && outside) {
          cutOff = true;
          if (isControl) clipped = true;
        }
        const scrolls = parent.overflowX === "auto" || parent.overflowX === "scroll";
        if (!cutOff && scrolls && box.right <= limit) {
          contained = true;
          break;
        }
        node = node.parentElement;
      }
      const pastScreen = rect.right > limit;
      if (clipped || (pastScreen && !contained)) {
        const name = (el.id ? "#" + el.id : el.tagName.toLowerCase()) + "." + String(el.className).slice(0, 48);
        seen.push(name + " right=" + Math.round(rect.right));
        if (seen.length >= 6) break;
      }
    }
    return seen;
  });
}

function clipFixture(fixed: boolean): string {
  const clip = fixed
    ? "#clip { width: 360px; height: 220px; overflow: hidden; }"
    : "#clip { width: 200px; height: 220px; overflow: hidden; }";
  const card = fixed
    ? "#card { width: 320px; overflow-x: auto; }"
    : "#card { width: 320px; overflow: hidden; }";
  const nudge = fixed ? "0" : "160px";
  return `<!doctype html><html><head><style>
    body { margin: 0; }
    ${clip}
    ${card}
    #clip button, #clip a, #clip input, #clip select { display: block; width: 80px; height: 32px; margin-left: ${nudge}; }
    table { width: 640px; border-collapse: collapse; }
    td { height: 28px; }
  </style></head><body>
    <div id="clip">
      <button id="cut" type="button">Cut off</button>
      <a id="cut-link" href="#gone">Link</a>
      <input id="cut-input" />
      <select id="cut-select"><option>A</option></select>
    </div>
    <div id="card"><table id="wide"><tr><td>Wide columns</td></tr></table></div>
  </body></html>`;
}

test("a clip does not count as a place to scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.setContent(clipFixture(false));
  const clipped = await overflowPast(page);
  expect(clipped.join("\n")).toContain("#cut");
  expect(clipped.join("\n")).toContain("#cut-link");
  expect(clipped.join("\n")).toContain("#cut-input");
  expect(clipped.join("\n")).toContain("#cut-select");
  expect(clipped.join("\n")).toContain("#wide");

  await page.setContent(clipFixture(true));
  expect(await overflowPast(page)).toEqual([]);
});

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
