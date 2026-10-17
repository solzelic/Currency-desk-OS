/* Phone headers on the public site: no sideways overflow, no
   overlapping links, and every header link at least 44px tall.
   See pricing, Sign in, Terms, and Privacy are included. */
import { test, expect } from "@playwright/test";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const WIDTHS = [360, 390, 430] as const;

const PAGES: { path: string; extra: string[] }[] = [
  { path: "/", extra: ["See pricing"] },
  { path: "/faq", extra: [] },
  { path: "/compliance", extra: [] },
  { path: "/contact", extra: [] },
  { path: "/legal", extra: [] },
  { path: "/signup", extra: ["Terms", "Privacy Policy"] },
];

test.use({ userAgent: IPHONE, isMobile: true, hasTouch: true });

for (const width of WIDTHS) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    for (const item of PAGES) {
      test(`${item.path} header`, async ({ page }) => {
        await page.goto(item.path);
        await page.evaluate(() => {
          const curtain = document.querySelector("[data-curtain]");
          if (curtain instanceof HTMLElement) curtain.style.display = "none";
        });
        const header = page.locator("[data-site-header]");
        await expect(header).toBeVisible();
        const summary = header.locator("summary");
        if (await summary.isVisible()) {
          await summary.click();
          await expect(header.locator("[data-site-links]")).toBeVisible();
        }

        const overflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);

        const boxes = await header.locator("a:visible, summary").evaluateAll((els) =>
          els.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              text: (el.textContent || "").replace(/\s+/g, " ").trim(),
              x: r.x,
              y: r.y,
              w: r.width,
              h: r.height,
              clipped: el.scrollWidth > el.clientWidth + 1,
            };
          }),
        );
        expect(boxes.length).toBeGreaterThan(0);
        for (const box of boxes) {
          expect(box.h, box.text).toBeGreaterThanOrEqual(44);
          expect(box.clipped, box.text).toBe(false);
          expect(box.x, box.text).toBeGreaterThanOrEqual(-1);
          expect(box.x + box.w, box.text).toBeLessThanOrEqual(width + 1);
        }
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i];
            const b = boxes[j];
            const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            expect(overlapX > 1 && overlapY > 1, `${a.text} overlaps ${b.text}`).toBe(false);
          }
        }

        for (const name of item.extra) {
          const link = page.getByRole("link", { name, exact: true });
          await expect(link).toBeVisible();
          const box = await link.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return { h: r.height, clipped: el.scrollWidth > el.clientWidth + 1 };
          });
          expect(box.h, name).toBeGreaterThanOrEqual(44);
          expect(box.clipped, name).toBe(false);
        }
      });
    }
  });
}
