/* The public pages used to ship <img src="{{ p.src }}">. The browser
   fetches that while parsing, before the design runtime substitutes
   the binding, so every visit 404s on a file named {{ p.src }}. The
   build parks those bindings on data-cd-src / data-cd-href, and the
   runtime promotes them only once they are real URLs.

   The same desktop page draws "Get early access" past the right edge
   at 390px. The centre links are already hidden; the row still kept
   three columns and the wordmark would not shrink. */
import type { Page, Request } from "@playwright/test";
import { test, expect } from "./fixtures";

const PAGES = ["/", "/d", "/m", "/compliance", "/faq", "/legal", "/contact", "/signup"];

function templateAttrs(html: string): string[] {
  const found: string[] = [];
  /* data-cd-src still holds the binding on purpose. Only a real
     src or href attribute is fetched during parse. */
  const re = /(?:^|[\s>])(src|href)\s*=\s*"([^"]*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[2].includes("{{")) found.push(m[0]);
  }
  return found;
}

test("served HTML has no unrendered {{ }} in src or href", async ({ page }) => {
  for (const path of PAGES) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    expect(templateAttrs(html), path).toEqual([]);
  }
});

async function headerBox(page: Page) {
  const cta = page.locator("[data-nav-cta]").first();
  await expect(cta).toBeVisible();
  return cta.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      client: el.clientWidth,
      scroll: el.scrollWidth,
      vw: document.documentElement.clientWidth,
    };
  });
}

test("the website image is a real file, and the header button fits a phone", async ({ page }) => {
  const urls: string[] = [];
  const onRequest = (req: Request) => urls.push(req.url());
  page.on("request", onRequest);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/d");
  const img = page.locator("#website img").first();
  await expect(img).toHaveAttribute("src", /\/web\/assets\/site-web-/);
  const src = await img.getAttribute("src");
  expect(src, "website image").toBeTruthy();
  const imgRes = await page.request.get(src!);
  expect(imgRes.status(), src!).toBe(200);
  const leaked = urls.filter((u) => u.includes("{{") || u.includes("%7B%7B"));
  expect(leaked).toEqual([]);

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/d");
    const box = await headerBox(page);
    expect(box.left, `header button left at ${width}`).toBeGreaterThanOrEqual(0);
    expect(box.right, `header button right at ${width}`).toBeLessThanOrEqual(box.vw + 0.5);
    expect(box.scroll, `header button text at ${width}`).toBeLessThanOrEqual(box.client + 1);
  }
  page.off("request", onRequest);
});
