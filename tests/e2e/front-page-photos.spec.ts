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
    /* Story frames keep their file until that section meets the viewport,
       so a feature preview is not sharing the connection with all five.
       Anything that does have a file on this screen is below the fold
       and lazy. The team photograph is the one that qualifies. */
    const vh = page.viewportSize()?.height ?? 800;
    const below = shots.filter((p) => p.top >= vh);
    expect(below.length, "photographs with a file are below the first screen").toBe(shots.length);
    for (const shot of below) {
      expect(shot.loading, shot.src).toBe("lazy");
      expect(shot.decoding, shot.src).toBe("async");
      expect(Number(shot.width), shot.src).toBeGreaterThan(0);
      expect(Number(shot.height), shot.src).toBeGreaterThan(0);
    }
    const story = await page.locator("#website img").evaluateAll((els) =>
      els.map((img) => ({
        loading: img.getAttribute("loading"),
        decoding: img.getAttribute("decoding"),
        width: img.getAttribute("width"),
        height: img.getAttribute("height"),
      })),
    );
    expect(story, "five story frames").toHaveLength(5);
    for (const frame of story) {
      expect(frame.loading).toBe("lazy");
      expect(frame.decoding).toBe("async");
      expect(Number(frame.width)).toBeGreaterThan(0);
      expect(Number(frame.height)).toBeGreaterThan(0);
    }
    const featureSlots = await page.locator("[data-scene='features'] image-slot").count();
    expect(featureSlots, "nine feature previews").toBe(9);
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
    /* The feature row sits just under the hero, so it may already be
       downloading. Those previews are not lazy: a hidden slide with
       loading=lazy stays blank when selected. */
    for (const shot of below) {
      expect(shot.loading, shot.src).not.toBe("lazy");
      expect(shot.decoding, shot.src).toBe("async");
      expect(Number(shot.width), shot.src).toBeGreaterThan(0);
      expect(Number(shot.height), shot.src).toBeGreaterThan(0);
    }
  } finally {
    await browser.close();
  }
});

/* Feature previews are stacked panes. A hidden pane with loading=lazy
   does not download, so selecting it leaves an empty frame. This scrolls
   the section into view on the same slow link as the measurement and
   selects every item. The picture that is actually showing has to be
   decoded within two seconds. */
async function slowPage(baseURL: string, width: number, height: number, userAgent?: string) {
  const { browser, page } = await openPage(baseURL, width, height, userAgent);
  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  await client.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1000 * 1000) / 8,
    uploadThroughput: (750 * 1000) / 8,
    connectionType: "cellular3g",
  });
  await page.goto("/", { waitUntil: "networkidle", timeout: 120_000 });
  await page.evaluate(() => {
    document.documentElement.style.scrollSnapType = "none";
    document.documentElement.style.scrollBehavior = "auto";
    const orig = window.scrollTo.bind(window);
    window.scrollTo = (opts, y) => {
      if (opts && typeof opts === "object") orig(Object.assign({}, opts, { behavior: "auto" }));
      else orig(opts, y);
    };
  });
  return { browser, page };
}

async function shownFeature(page: Page): Promise<{ src: string; complete: boolean; naturalWidth: number } | null> {
  return page.evaluate(() => {
    const section = document.querySelector("[data-scene='features']") || document.querySelector("#product");
    if (!section) return null;
    let found: { src: string; complete: boolean; naturalWidth: number } | null = null;
    const visit = (root: ParentNode) => {
      root.querySelectorAll("img").forEach((img) => {
        if (found || img.classList.contains("ghost")) return;
        const src = img.getAttribute("src") || "";
        if (!/\/web\/(photos|assets)\//.test(src)) return;
        let node: Element | null = img.getRootNode() instanceof ShadowRoot
          ? (img.getRootNode() as ShadowRoot).host
          : img;
        let opacity = 1;
        let visibility = "visible";
        for (let i = 0; i < 8 && node; i++) {
          const cs = getComputedStyle(node);
          opacity = Math.min(opacity, Number(cs.opacity));
          if (cs.visibility === "hidden" || cs.display === "none") visibility = "hidden";
          node = node.parentElement;
        }
        const own = getComputedStyle(img);
        opacity = Math.min(opacity, Number(own.opacity));
        if (own.visibility === "hidden") visibility = "hidden";
        if (visibility === "hidden" || opacity < 0.9) return;
        const box = img.getBoundingClientRect();
        if (box.width < 40 || box.height < 40) return;
        if (box.bottom < 0 || box.top > window.innerHeight) return;
        found = { src, complete: img.complete, naturalWidth: img.naturalWidth };
      });
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    };
    visit(section);
    return found;
  });
}

async function expectShownPhoto(page: Page) {
  await expect.poll(async () => {
    const shot = await shownFeature(page);
    return !!(shot && shot.complete && shot.naturalWidth > 0);
  }, { timeout: 2_000, intervals: [80] }).toBe(true);
}

test("desktop feature previews are pictures when each item is selected", async ({ baseURL }) => {
  const { browser, page } = await slowPage(baseURL!, 1280, 800);
  try {
    await page.evaluate(() => {
      const scene = document.querySelector("[data-scene='features']") as HTMLElement;
      window.scrollTo(0, scene.offsetTop + 40);
    });
    const rails = page.locator("[data-rail]");
    await expect(rails).toHaveCount(9);
    for (let i = 0; i < 9; i++) {
      await rails.nth(i).click({ position: { x: 24, y: 16 } });
      await expect.poll(async () => page.evaluate((index) => {
        const rails = Array.from(document.querySelectorAll("[data-rail]"));
        const active = rails.findIndex((el) => el.getAttribute("data-active") === "true");
        if (active !== index) return "active:" + active;
        const scene = document.querySelector("[data-scene='features']");
        const slot = scene && scene.querySelector("image-slot[fetchpriority='high']");
        if (!slot || !slot.shadowRoot) return "noslot";
        const img = slot.shadowRoot.querySelector("img:not(.ghost)");
        if (!img) return "noimg";
        if (!img.complete || img.naturalWidth <= 0) return "loading:" + String(img.complete) + ":" + img.naturalWidth + ":" + (img.currentSrc || "").split("/").pop();
        let node = slot;
        let opacity = 1;
        let visibility = "visible";
        for (let n = 0; n < 6 && node; n++) {
          const cs = getComputedStyle(node);
          opacity = Math.min(opacity, Number(cs.opacity));
          if (cs.visibility === "hidden" || cs.display === "none") visibility = "hidden";
          node = node.parentElement;
        }
        if (visibility === "hidden" || opacity < 0.9) return "fade:" + opacity.toFixed(2);
        return "ok";
      }, i), { timeout: 2_000, intervals: [80] }).toBe("ok");
    }
  } finally {
    await browser.close();
  }
});

test("phone feature previews are pictures when each item is selected", async ({ baseURL }) => {
  const { browser, page } = await slowPage(baseURL!, 390, 844, PHONE_UA);
  try {
    await page.evaluate(() => {
      const scene = document.querySelector("#product") as HTMLElement;
      window.scrollTo(0, Math.max(0, scene.offsetTop - 20));
    });
    const labels = await page.locator("#product button[aria-label]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label") || "").filter((label) => label && label !== "Previous" && label !== "Next"),
    );
    expect(labels).toHaveLength(9);
    for (const label of labels) {
      await page.locator(`#product button[aria-label="${label}"]`).click();
      await expectShownPhoto(page);
    }
  } finally {
    await browser.close();
  }
});
