/* One desktop picture for the whole desk.
   At 1280 the open window of every app, and the sign-in screen, must
   match the PNG committed from the GitHub Actions artifact
   desktop-unchanged-baselines.

   maxDiffPixels is 20 and threshold is 0.2. On Actions run
   38188660101 the Till window matched on the first attempt and
   differed by 6 pixels on the retry. Those pixels are antialiasing
   on the "Hand off" control and a lower rule, not different text.
   threshold 0.2 is how far a pixel's colour may move before it counts.
   20 is the ceiling for the pixels that still count. The Till retry
   was 6. A content change is not in that budget.
   The Cheques window on the same run differed by 592 pixels in one
   band: the customer id `cust_` plus a live UUID. That is content.
   It is frozen below, and 20 pixels does not cover it.

   A laptop paints the fallback font differently from Actions. That
   gap is thousands of pixels and is not a layout change. Do not
   regenerate these files locally. A screen PR that needs a new PNG
   has changed the desktop. That is a blocker. See docs/PHONE_SHELL.md. */
import type { Locator, Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const DESKTOP = { width: 1280, height: 800 };

/* The strings already painted in the committed PNGs. A later run
   rewrites the live text to these before the shot, so the pictures
   stay the ones Actions rendered. Do not point them at new copy. */
const FROZEN_DAY = "Monday, October 12, 2026";
const FROZEN_ISO = "2026-06-18";
const FROZEN_TIME = "14:30";
const FROZEN_UUID = "00000000-0000-4000-8000-000000000000";

const SHOT = {
  maxDiffPixels: 20,
  threshold: 0.2,
  animations: "disabled" as const,
  caret: "hide" as const,
  scale: "css" as const,
};

/* The dock id, and the title the open window must show. */
const APPS: { id: string; title: RegExp }[] = [
  { id: "ledger", title: /Ledger/ },
  { id: "clients", title: /Clients/ },
  { id: "rates", title: /Rate Board/ },
  { id: "till", title: /Cash Drawer/ },
  { id: "compliance", title: /Compliance/ },
  { id: "reports", title: /Reports/ },
  { id: "settings", title: /Settings/ },
  { id: "pricing", title: /Pricing/ },
  { id: "transfers", title: /Transfers/ },
  { id: "cheques", title: /Cheques/ },
  { id: "vault", title: /Vault/ },
  { id: "audit", title: /Audit/ },
];

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

/* Dates, clock times, transaction refs, and seam-run name suffixes
   change every run. The same replacement runs on every capture, so
   the committed PNG and the next run show the same text.

   The Cheques band on run 38188660101 was `cust_` plus a new UUID
   each suite. The ledger mints that id with randomUUID. "_" is a
   word character, so a boundary in front of the UUID never matched
   and the id stayed live (592 pixels). The replacement below has
   no boundary. The audit picture also has two day headings. Only the
   suite day moves; "Thursday, June 18, 2026" stays as painted. AM and
   PM stay as painted too. */
async function freezeWindowText(page: Page): Promise<void> {
  /* The walk stays in the page. A round trip per text node timed the
     test out on the ledger. */
  await page.locator(".win.show.active").evaluate((root, frozen) => {
    const rewrite = (text: string) => {
      let next = text.replace(/refreshed\s+\S+(\s+\S+)?/g, "refreshed 2m ago");
      next = next.replace(
        /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}\b/g,
        (match) => (match.includes("June 18, 2026") ? match : frozen.day),
      );
      next = next.replace(/\b\d{4}-\d{2}-\d{2}\b/g, frozen.iso);
      next = next.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, frozen.time);
      next = next.replace(/\b\d+h \d+m(?: \d+s)?\b/g, "2h 00m");
      next = next.replace(/\b\d+m \d+s\b/g, "2m 00s");
      next = next.replace(/\b\d+s\b/g, "00s");
      next = next.replace(/\bCD-\d{6}-[0-9a-z]+\b/gi, "CD-260618-frozen");
      next = next.replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{6}\b/g, "000000");
      next = next.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, frozen.uuid);
      return next;
    };
    const stopIntervals = (win: Window) => {
      const probe = win.setInterval(() => {}, 1_000_000_000);
      win.clearInterval(probe);
      /* A faked clock hands out timer ids from 1e12. Walking those
         never finishes. Native ids stay small. */
      if (probe > 100000) return;
      for (let i = 1; i < probe; i++) win.clearInterval(i);
    };
    const fix = (scope: ParentNode) => {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent || "";
        const next = rewrite(text);
        if (next !== text) node.textContent = next;
        node = walker.nextNode();
      }
      scope.querySelectorAll("input, textarea").forEach((el) => {
        const field = el as HTMLInputElement;
        const next = rewrite(field.value || "");
        if (next !== field.value) field.value = next;
      });
      scope.querySelectorAll("[title], [aria-label], [placeholder]").forEach((el) => {
        for (const attr of ["title", "aria-label", "placeholder"]) {
          const value = el.getAttribute(attr);
          if (value == null) continue;
          const next = rewrite(value);
          if (next !== value) el.setAttribute(attr, next);
        }
      });
    };
    /* A ticking interval repaints a clock between this walk and the
       shot. Stop the window's intervals, then the text. */
    stopIntervals(window);
    fix(root);
    root.querySelectorAll("iframe").forEach((frame) => {
      try {
        const win = frame.contentWindow;
        if (win) stopIntervals(win);
        const body = frame.contentDocument && frame.contentDocument.body;
        if (body) fix(body);
      } catch (err) {
        /* A cross-origin frame is not part of this window's text. */
      }
    });
  }, { day: FROZEN_DAY, iso: FROZEN_ISO, time: FROZEN_TIME, uuid: FROZEN_UUID });
}

/* The page clock stays at the instant this test started. Timers are
   left real: Playwright's clock hands out timer ids from 1e12, and
   clearing them never finishes. #128's server header `x-cd-now` is
   not on this branch, and the rows in these windows were written by
   earlier tests, so a header on this page would not rewrite them.
   freezeWindowText turns those timestamps into the committed strings. */
async function pinPageClock(page: Page): Promise<void> {
  const pinned = Date.now();
  await page.addInitScript((ms) => {
    const RealDate = Date;
    function PinnedDate(this: Date, ...args: unknown[]) {
      if (!new.target) return new RealDate(ms).toString();
      if (args.length === 0) return new RealDate(ms);
      return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
    }
    PinnedDate.now = () => ms;
    PinnedDate.parse = RealDate.parse;
    PinnedDate.UTC = RealDate.UTC;
    PinnedDate.prototype = RealDate.prototype;
    (window as unknown as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;
  }, pinned);
}

/* Rates are already served with RATES_SYNC=off. Replay the first
   response so a later poll cannot change a mid while the windows
   are being photographed. */
async function pinRates(page: Page): Promise<void> {
  const seen = new Map<string, { status: number; body: string; contentType: string }>();
  await page.route("**/api/rates**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const key = route.request().url();
    const hit = seen.get(key);
    if (hit) {
      await route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body });
      return;
    }
    const response = await route.fetch();
    const body = await response.text();
    const contentType = response.headers()["content-type"] || "application/json";
    seen.set(key, { status: response.status(), body, contentType });
    await route.fulfill({ status: response.status(), contentType, body });
  });
}

async function fontsReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  for (const frame of page.frames()) {
    await frame.evaluate(async () => {
      if (document.fonts) await document.fonts.ready;
    }).catch(() => {});
  }
}

async function openDesktopApp(page: Page, id: string, title: RegExp): Promise<Locator> {
  const dock = page.locator(`#appbar [data-app="${id}"]`);
  await dock.scrollIntoViewIfNeeded();
  await dock.click();
  const win = page.locator(".win.show.active");
  await expect(win.locator(".win-title")).toContainText(title);
  await expect(win).toHaveCSS("transform", "none");
  /* The title bar retracts on a timer. The settled window is the one
     with the bar hidden. Capturing before that races the timer. */
  await expect(win).toHaveClass(/bar-hidden/);
  await dismissTour(page);
  await freezeWindowText(page);
  await fontsReady(page);
  return win;
}

test("sign-in is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await pinPageClock(page);
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.reload();
  const lock = page.locator("#lock");
  await expect(lock).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await fontsReady(page);
  await expect(lock).toHaveScreenshot("sign-in-1280.png", SHOT);
});

test("every desktop window is unchanged at 1280", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DESKTOP);
  await pinPageClock(page);
  await pinRates(page);
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  await expect(page.locator("#phonebar")).toBeHidden();
  await expect(page.locator("#appbar")).toBeVisible();

  for (const app of APPS) {
    const win = await openDesktopApp(page, app.id, app.title);
    const frame = page.frameLocator('iframe[title="Rate Board"]');
    const since = frame.locator("#edSince");
    const mask = app.id === "rates" && await since.isVisible().catch(() => false)
      ? [since, frame.locator("#feedLastWrap"), frame.locator("#feedNextWrap"), frame.locator("#feedLabel")]
      : undefined;
    await expect(win).toHaveScreenshot(`${app.id}-1280.png`, { ...SHOT, mask });
  }
});
