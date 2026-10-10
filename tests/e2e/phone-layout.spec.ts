/* A phone has no spare desktop. At 390 and 360 the sign-in card and
   the key desk screens have to stay inside the viewport. A table may
   scroll inside its own card. The page itself may not grow sideways.
   Tagged is a separate fix and is not opened here.

   overflow:hidden cuts the content off. It is not a place to scroll.
   Only overflow auto or scroll counts as containment, and only when
   that box itself sits inside the screen. A button, link, input, or
   select that sticks out of a hidden ancestor is still cut off, so
   the check fails.

   Overlap is a different failure. A window title or a module tab can
   sit inside the viewport and still be unreadable because another
   element is painted on top of it. The centre of each front-window
   title and each on-screen tab is asked with elementFromPoint. A
   title whose box intersects a window dot, or a tab whose visible
   box intersects a floating store or ID button, fails as well.
   The title does not take pointer events, so a hit on its own bar
   is the title showing through. The first-run card is skipped when
   it is up, the same way the seam specs skip it, so this check is
   the chrome. */
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

/* The title is pointer-events: none, so elementFromPoint falls
   through it onto the bar. A dot or a tool button on that point
   does not. A tab takes its own hits; a floating button on top
   of it does not. Intersection uses the tab's box clipped to the
   app bar, so a tab scrolled out of that bar is not a cover. */
async function covered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const hits: string[] = [];
    const shown = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    };
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) =>
      a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    const nameOf = (el: Element | null) => {
      if (!el || !(el instanceof HTMLElement)) return "nothing";
      const id = el.id ? "#" + el.id : el.tagName.toLowerCase();
      const cls = String(el.className || "").trim().slice(0, 60);
      return cls ? id + "." + cls : id;
    };

    for (const title of document.querySelectorAll(".win.show.active .win-title")) {
      if (!shown(title)) continue;
      const tr = title.getBoundingClientRect();
      const label = (title.textContent || "").replace(/\s+/g, " ").trim() || "window";
      const cx = tr.left + tr.width / 2;
      const cy = tr.top + tr.height / 2;
      if (cx >= 1 && cy >= 1 && cx <= innerWidth - 1 && cy <= innerHeight - 1) {
        const hit = document.elementFromPoint(cx, cy);
        const bar = title.closest(".win-bar");
        const onBar = !!hit && !!bar && bar.contains(hit);
        const clear = !!hit && (hit === title || title.contains(hit) || (onBar && !hit.closest(".win-lights") && !hit.closest(".win-rtools") && !hit.closest(".win-back")));
        if (!clear) hits.push(`title "${label}" centre is ${nameOf(hit)}`);
      }
      const win = title.closest(".win");
      if (!win) continue;
      for (const dot of win.querySelectorAll(".win-tb-btn")) {
        if (!shown(dot)) continue;
        const dr = dot.getBoundingClientRect();
        if (overlaps(tr, dr)) {
          hits.push(`title "${label}" intersects a window dot ${Math.round(dr.width)}x${Math.round(dr.height)}`);
          break;
        }
      }
    }

    const appbar = document.getElementById("appbar");
    const appBox = appbar ? appbar.getBoundingClientRect() : null;
    const floaters = [...document.querySelectorAll(".edge-rail .mb-op")].filter(shown);
    for (const tab of document.querySelectorAll("#appbar .app-btn")) {
      if (!shown(tab)) continue;
      const raw = tab.getBoundingClientRect();
      const visible = appBox
        ? {
            left: Math.max(raw.left, appBox.left),
            top: Math.max(raw.top, appBox.top),
            right: Math.min(raw.right, appBox.right),
            bottom: Math.min(raw.bottom, appBox.bottom),
          }
        : raw;
      if (visible.right - visible.left < 2 || visible.bottom - visible.top < 2) continue;
      const label = tab.getAttribute("data-app") || "tab";
      const cx = (visible.left + visible.right) / 2;
      const cy = (visible.top + visible.bottom) / 2;
      if (cx >= 1 && cy >= 1 && cx <= innerWidth - 1 && cy <= innerHeight - 1) {
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || (hit !== tab && !tab.contains(hit))) hits.push(`tab "${label}" centre is ${nameOf(hit)}`);
      }
      for (const btn of floaters) {
        const br = btn.getBoundingClientRect();
        if (overlaps(visible, br)) {
          hits.push(`tab "${label}" intersects a floating button ${Math.round(br.width)}x${Math.round(br.height)}`);
          break;
        }
      }
    }
    return hits;
  });
}

/* The window scales in over a third of a second. A box measured
   during that scale is a few pixels small and can miss a real overlap. */
async function settledWindow(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

/* The module tabs are hidden on a phone. Rates, Ledger, Clients, and
   Till are on the bottom bar. Everything else is a row under More. */
async function openOnPhone(page: Page, id: string): Promise<void> {
  const tab = page.locator(`#phonebar [data-phone-app="${id}"]`);
  if (await tab.count()) {
    await tab.click();
    return;
  }
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator(`#phone-more [data-phone-app="${id}"]`).click();
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
    await dismissTour(page);
    for (const id of SCREENS) {
      await openOnPhone(page, id);
      await expect(page.locator(".win.show").first()).toBeVisible();
      await dismissTour(page);
      await settledWindow(page);
      expect(await overflowPast(page), `${id} at ${width}px`).toEqual([]);
      expect(await covered(page), `${id} at ${width}px`).toEqual([]);
    }
    /* Settings is not on a senior teller's More list. An owner still
       opens it from there, and that form is the one this check covers. */
    await signInAtDesk(page, "j.masri");
    await dismissTour(page);
    await openOnPhone(page, "settings");
    await expect(page.locator(".win.show").first()).toBeVisible();
    await dismissTour(page);
    await settledWindow(page);
    expect(await overflowPast(page), `settings at ${width}px`).toEqual([]);
    expect(await covered(page), `settings at ${width}px`).toEqual([]);
  }
});
