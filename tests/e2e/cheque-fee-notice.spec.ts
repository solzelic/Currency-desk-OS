/* The fee notice is a sentence with the lock in the first line.
   On a 360px phone that line has to wrap. A row that runs off the
   screen is the notice cut off, which is what this check refuses. */
import { test, expect, signInAtDesk } from "./fixtures";

test("the fee notice wraps at 360", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="cheques"]').click();
  await page.getByRole("button", { name: "Fee schedule" }).click();
  const note = page.getByTestId("fee-schedule-lock");
  await expect(note).toContainText("Ask a manager to make this change.");
  const box = await note.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    const tops = rects.map((r) => Math.round(r.top));
    const lines = tops.filter((t, i) => tops.findIndex((u) => Math.abs(u - t) < 3) === i);
    const edge = document.documentElement.clientWidth;
    return {
      lines: lines.length,
      past: rects.some((r) => r.right > edge + 1 || r.left < -1),
      scroll: el.scrollWidth > el.clientWidth + 1,
      edge,
    };
  });
  expect(box.lines).toBeGreaterThan(1);
  expect(box.past).toBe(false);
  expect(box.scroll).toBe(false);
});
