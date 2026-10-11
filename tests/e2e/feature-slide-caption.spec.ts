/* The phone marketing page ("What the desk does") paints each feature
   photo at z-index 2 and used to leave the label and title at auto, so
   the picture covered the words as soon as the crossfade finished.
   A caption that is merely in the DOM is not readable. This checks the
   computed opacity and that the words are the pixels on top. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent: IPHONE,
  isMobile: true,
  hasTouch: true,
});

async function expectCaptionHeld(page: Page) {
  const caption = page.locator("[data-feat-caption]");
  await expect(caption).toBeVisible();
  const opacity = await caption.evaluate((el) => getComputedStyle(el).opacity);
  expect(opacity).toBe("1");
  /* The caption wrapper ignores taps so a swipe still moves the slide.
     Hit-testing has to opt back in, or the photo underneath is what
     elementFromPoint reports even when the words are painted on top. */
  const onTop = await caption.evaluate((el) => {
    const lines = [...el.querySelectorAll("div")];
    const title = lines[lines.length - 1] ?? el;
    const previous = title.style.pointerEvents;
    title.style.pointerEvents = "auto";
    const r = title.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(28, r.width / 3), r.top + r.height / 2);
    title.style.pointerEvents = previous;
    return !!hit && (hit === title || title.contains(hit));
  });
  expect(onTop).toBe(true);
}

test("feature slide captions stay visible on a phone", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("What the desk does")).toBeVisible();
  await page.evaluate(() => {
    const el = document.querySelector("#product");
    if (!el) return;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY);
  });

  const caption = page.locator("[data-feat-caption]");
  await expect(caption).toContainText("Your board, everywhere");
  await page.waitForTimeout(3000);
  await expectCaptionHeld(page);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(caption).toContainText("Bring them back");
  await page.waitForTimeout(3000);
  await expectCaptionHeld(page);
});

/* Nothing is tapped. The card publishes its dwell on data-feat-ms (6.5s).
   Autoplay stays paused until the card is actually on screen, so the
   clock starts once the fill on the current segment is running. */
test("feature slides advance on their own after the dwell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("What the desk does")).toBeVisible();
  const card = page.locator("[data-feat-card]");
  await card.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));

  await expect.poll(async () => card.getAttribute("data-feat-ms")).toMatch(/^[6-7]\d{3}$/);
  const dwell = Number(await card.getAttribute("data-feat-ms"));
  expect(dwell).toBeGreaterThanOrEqual(6000);
  expect(dwell).toBeLessThanOrEqual(7000);

  const caption = page.locator("[data-feat-caption]");
  await expect(caption).toContainText("Your board, everywhere");
  await expect.poll(async () => {
    return page.locator('#product button[aria-current="true"] span').evaluate((el) => getComputedStyle(el).animationName);
  }).toMatch(/cdFeatFill/);
  const started = Date.now();

  await page.waitForTimeout(Math.round(dwell / 2));
  await expect(caption).toContainText("Your board, everywhere");

  await expect(caption).toContainText("Bring them back", { timeout: dwell });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(dwell - 1500);
  expect(elapsed).toBeLessThan(dwell + 3000);

  await expect.poll(async () => caption.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  await expectCaptionHeld(page);
  await expect(page.locator('#product button[aria-current="true"]')).toHaveAttribute("aria-label", "Bring them back");
});
