/* The home story is one list. The dots, the scroll, the autoplay
   tick and a swipe all use that length, so the last panel wraps to
   the first and the first wraps to the last. */
import { expect, test, type Page } from "./fixtures";

const KICK = ["01 · THE WEBSITE", "02 · THE VISIT", "03 · THE CODE", "04 · THE DEAL"];

function shown(page: Page) {
  return page.locator("[data-story-grid]").evaluate((grid) => {
    const layer = [...grid.querySelectorAll("img")].map((img) => img.parentElement).find((el) => el && getComputedStyle(el).visibility === "visible");
    const badge = [...grid.querySelectorAll("div")].map((el) => (el.textContent || "").trim()).find((text) => /^\d\d \/ \d\d$/.test(text)) || "";
    return { text: layer?.innerText || "", badge };
  });
}

test("story dots match the panels and wrap both ways", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  const scene = page.locator("[data-scene='website']");
  await expect(scene).toBeVisible();
  await page.waitForFunction(() => !!(document.querySelector("[data-scene='website']") as HTMLElement & { __storyStep?: (dir: number) => void }).__storyStep);
  const dots = await page.locator("[data-story-steps] span").evaluateAll((els) => els.filter((el) => getComputedStyle(el).width === "24px" && getComputedStyle(el).height === "24px").length);
  const defs = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return (src.slice(src.indexOf("storyDefs()"), src.indexOf("state =")).match(/kicker:'/g) || []).length;
  });
  expect(dots, "dot count").toBe(defs);
  expect(dots).toBe(KICK.length);
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.documentElement.style.scrollSnapType = "none"; });
  for (let i = 0; i < dots; i++) {
    await page.evaluate((i) => {
      const el = document.querySelector("[data-scene='website']") as HTMLElement;
      const n = [...document.querySelectorAll("[data-story-steps] span")].filter((dot) => getComputedStyle(dot).width === "24px").length;
      window.scrollTo(0, el.offsetTop + ((i + 0.5) / n) * Math.max(1, el.offsetHeight - window.innerHeight));
    }, i);
    await expect.poll(() => shown(page)).toMatchObject({ text: expect.stringContaining(KICK[i]!), badge: `0${i + 1} / 0${dots}` });
  }
  await page.evaluate((dir) => (document.querySelector("[data-scene='website']") as HTMLElement & { __storyStep: (dir: number) => void }).__storyStep(dir), 1);
  await expect.poll(() => shown(page)).toMatchObject({ text: expect.stringContaining(KICK[0]!) });
  const swipe = (from: number, to: number) => page.evaluate(([from, to]) => {
    const el = document.querySelector("[data-story-grid]") as HTMLElement;
    const fire = (type: string, x: number) => {
      const touch = new Touch({ identifier: 1, target: el, clientX: x, clientY: 160 });
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, changedTouches: [touch], touches: type === "touchend" ? [] : [touch] }));
    };
    fire("touchstart", from);
    fire("touchend", to);
  }, [from, to] as const);
  await swipe(30, 180);
  await expect.poll(() => shown(page)).toMatchObject({ text: expect.stringContaining(KICK[dots - 1]!) });
  await swipe(180, 30);
  await expect.poll(() => shown(page)).toMatchObject({ text: expect.stringContaining(KICK[0]!) });
});
