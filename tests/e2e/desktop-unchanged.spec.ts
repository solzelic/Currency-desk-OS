/* One desktop picture for the whole desk.
   At 1280 the open window of every app, and the sign-in screen, must
   match the PNG committed from the GitHub Actions artifact
   desktop-unchanged-baselines. maxDiffPixels is 0.

   A laptop paints the fallback font differently from Actions. That
   gap is thousands of pixels and is not a layout change. Do not
   regenerate these files locally. A screen PR that needs a new PNG
   has changed the desktop. That is a blocker. See docs/PHONE_SHELL.md. */
import type { Locator, Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

const DESKTOP = { width: 1280, height: 800 };

const SHOT = {
  maxDiffPixels: 0,
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

/* Dates, clock times, and "refreshed 2m ago" would make a pixel
   baseline fail the next minute. The same replacement runs on every
   capture, so the committed PNG and the next run show the same text. */
async function freezeWindowText(page: Page): Promise<void> {
  await page.locator(".win.show.active").evaluate((root) => {
    const fix = (scope: Node) => {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const text = node.textContent || "";
        let next = text.replace(/refreshed\s+\S+(\s+\S+)?/g, "refreshed 2m ago");
        next = next.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "2026-06-18");
        next = next.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "14:30");
        next = next.replace(/\b\d+h \d+m(?: \d+s)?\b/g, "2h 00m");
        next = next.replace(/\b\d+m \d+s\b/g, "2m 00s");
        next = next.replace(/\b\d+s\b/g, "00s");
        if (next !== text) node.textContent = next;
        node = walker.nextNode();
      }
    };
    fix(root);
    root.querySelectorAll("iframe").forEach((frame) => {
      try {
        const win = frame.contentWindow;
        if (win) {
          /* The rate board ticks every second. Stop those timers
             before the text is frozen, or the next tick repaints
             "Updated 12s ago" between the freeze and the picture. */
          const probe = win.setInterval(() => {}, 1_000_000_000);
          for (let i = 1; i <= probe; i++) win.clearInterval(i);
        }
        const body = frame.contentDocument && frame.contentDocument.body;
        if (body) fix(body);
      } catch (err) {
        /* A cross-origin frame is not part of this window's text. */
      }
    });
  });
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
  return win;
}

test("sign-in is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
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
  await expect(lock).toHaveScreenshot("sign-in-1280.png", SHOT);
});

test("every desktop window is unchanged at 1280", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(DESKTOP);
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
