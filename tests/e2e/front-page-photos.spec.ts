/* ============================================================
   The public front page should not download every photograph
   before anyone has scrolled.

   Measured on main: GET / transfers about 5 MB, and 4.8 MB of
   that is fifteen JPEGs fetched together. Nothing below the
   first screen says loading="lazy". The preload scanner also
   requests a literal {{ p.src }} because that placeholder is
   an <img src> in the design template before the runtime
   fills it in.

   This file is the gate for that. It loads / and does not
   scroll. It does not need the ledger — the page is public —
   so it must not skip when SEAM_DATABASE_URL is absent.
   ============================================================ */
import { test, expect, chromium, type Page } from "@playwright/test";

/* Desktop first screen has no photograph. The smallest WebP on the
   page is about 50 KB, so this fails if any of them load before
   the scroll. */
const DESKTOP_IMAGE_BUDGET = 20_000;

/* The phone hero is one photograph. The nine feature photographs
   sit about 250px below that fold. On a 1.6 Mbps link Chromium still
   fetches a lazy image that close, so this budget is the WebP weight
   of that row, not zero. The JPEG row is 2.4 MB and fails it. */
const PHONE_IMAGE_BUDGET = 1_400_000;

const PHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type Photo = {
  src: string;
  loading: string | null;
  decoding: string | null;
  width: string | null;
  height: string | null;
  top: number;
  paints: boolean;
};

function placeholderUrl(url: string): boolean {
  return url.includes("{{") || url.includes("%7B%7B") || url.includes("%7b%7b");
}

/* Chromium on a fast localhost fetches lazy images that are still
   several viewports down. Pin the threshold to the viewport so the
   byte budget is the first screen, which is what a slow counter
   connection actually has to pay for before anyone scrolls. */
async function openPage(baseURL: string, width: number, height: number, userAgent?: string) {
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ["--blink-settings=lazyImageLoadingDistanceThresholdPx=0"],
  });
  const page = await browser.newPage({
    baseURL,
    viewport: { width, height },
    userAgent,
  });
  return { browser, page };
}

async function imageBytesBeforeScroll(page: Page, path: string) {
  /* Same shape as the measurement: 1.6 Mbps, 150 ms RTT. A fast
     localhost makes Chromium prefetch lazy images thousands of
     pixels down, which is not the first screen. */
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1000 * 1000) / 8,
    uploadThroughput: (750 * 1000) / 8,
    connectionType: "cellular3g",
  });
  const urls: string[] = [];
  const onRequest = (req: import("@playwright/test").Request) => urls.push(req.url());
  page.on("request", onRequest);
  let bytes = 0;
  const onResponse = async (res: import("@playwright/test").Response) => {
    if (res.request().resourceType() !== "image") return;
    const header = Number(res.headers()["content-length"] || 0);
    if (header > 0) {
      bytes += header;
      return;
    }
    try {
      bytes += (await res.body()).length;
    } catch {
      /* a cancelled image still counts as a request; the URL check covers it */
    }
  };
  page.on("response", onResponse);
  await page.goto(path, { waitUntil: "networkidle" });
  page.off("request", onRequest);
  page.off("response", onResponse);
  return { bytes, urls };
}

async function photos(page: import("@playwright/test").Page): Promise<Photo[]> {
  return page.evaluate(() => {
    const found: Photo[] = [];
    const visit = (root: ParentNode) => {
      root.querySelectorAll("img").forEach((img) => {
        if (img.classList.contains("ghost")) return;
        const src = img.currentSrc || img.getAttribute("src") || "";
        if (!/\/web\/(photos|assets)\//.test(src)) return;
        const box = img.getBoundingClientRect();
        found.push({
          src,
          loading: img.getAttribute("loading"),
          decoding: img.getAttribute("decoding"),
          width: img.getAttribute("width"),
          height: img.getAttribute("height"),
          top: box.top,
          paints: box.width > 0 && box.height > 0,
        });
      });
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    };
    visit(document);
    return found;
  });
}

test("desktop front page keeps first-screen images small and does not request a template", async ({ baseURL }) => {
  const { browser, page } = await openPage(baseURL!, 1280, 800);
  try {
    const { bytes, urls } = await imageBytesBeforeScroll(page, "/");
    const leaked = urls.filter(placeholderUrl);
    expect(leaked, "a template placeholder was requested").toEqual([]);
    expect(bytes, "image bytes transferred before scroll").toBeLessThan(DESKTOP_IMAGE_BUDGET);

    const shots = (await photos(page)).filter((p) => p.paints);
    expect(shots.length, "the fifteen photographs should be in the page").toBeGreaterThanOrEqual(15);
    const vh = page.viewportSize()?.height ?? 800;
    const below = shots.filter((p) => p.top >= vh);
    expect(below.length, "every desktop photograph is below the first screen").toBe(shots.length);
    for (const shot of below) {
      expect(shot.loading, shot.src).toBe("lazy");
      expect(shot.decoding, shot.src).toBe("async");
      expect(Number(shot.width), shot.src).toBeGreaterThan(0);
      expect(Number(shot.height), shot.src).toBeGreaterThan(0);
    }
  } finally {
    await browser.close();
  }
});

test("phone front page lazy-loads below the hero and does not request a template", async ({ baseURL }) => {
  const { browser, page } = await openPage(baseURL!, 390, 844, PHONE_UA);
  try {
    const { bytes, urls } = await imageBytesBeforeScroll(page, "/");
    const leaked = urls.filter(placeholderUrl);
    expect(leaked, "a template placeholder was requested").toEqual([]);
    expect(bytes, "image bytes transferred before scroll").toBeLessThan(PHONE_IMAGE_BUDGET);

    const shots = (await photos(page)).filter((p) => p.paints);
    expect(shots.length).toBeGreaterThanOrEqual(10);
    const vh = 844;
    const hero = shots.filter((p) => p.top < vh && p.top >= 0);
    const below = shots.filter((p) => p.top >= vh);
    expect(hero, "the first screen has the one hero photograph").toHaveLength(1);
    expect(hero[0].loading, hero[0].src).not.toBe("lazy");
    expect(Number(hero[0].width)).toBeGreaterThan(0);
    expect(Number(hero[0].height)).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
    for (const shot of below) {
      expect(shot.loading, shot.src).toBe("lazy");
      expect(shot.decoding, shot.src).toBe("async");
      expect(Number(shot.width), shot.src).toBeGreaterThan(0);
      expect(Number(shot.height), shot.src).toBeGreaterThan(0);
    }
  } finally {
    await browser.close();
  }
});
