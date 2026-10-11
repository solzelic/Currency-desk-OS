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
