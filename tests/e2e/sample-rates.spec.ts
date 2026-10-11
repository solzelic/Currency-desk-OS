/* The hero rates are invented figures. Each surface has to say so
   inside its own box, where a visitor at that width can read it.
   A label that has scrolled out of the strip does not count. */
import { test, expect, type Page } from "./fixtures";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

function lin(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseRgb(value: string): [number, number, number, number] | null {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
}

/* AA for text under 18px, or under 14px bold. */
async function expectSampleInside(page: Page, selector: string) {
  const surface = page.locator(selector);
  await expect(surface).toBeVisible();
  const label = surface.getByText("Sample rates", { exact: true });
  await expect(label).toBeVisible();
  const reading = await label.evaluate((el) => {
    const host = el.closest("[data-hero-rates]");
    if (!host) return null;
    const text = el.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    const inside =
      text.width > 8 &&
      text.height > 8 &&
      text.top >= box.top - 1 &&
      text.bottom <= box.bottom + 1 &&
      text.left >= box.left - 1 &&
      text.right <= box.right + 1;
    const color = getComputedStyle(el).color;
    let node: Element | null = el;
    let background = "rgba(0, 0, 0, 0)";
    while (node) {
      const painted = getComputedStyle(node).backgroundColor;
      const parts = painted.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
      const alpha = parts && parts[4] !== undefined ? Number(parts[4]) : parts ? 1 : 0;
      if (parts && alpha > 0.95) {
        background = painted;
        break;
      }
      node = node.parentElement;
    }
    return { inside, color, background };
  });
  expect(reading, `${selector} has no readable Sample label`).not.toBeNull();
  expect(reading!.inside, `${selector} Sample label is outside its box`).toBe(true);
  const fg = parseRgb(reading!.color);
  const bg = parseRgb(reading!.background);
  expect(fg, reading!.color).not.toBeNull();
  expect(bg, reading!.background).not.toBeNull();
  const L = (rgb: [number, number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const lighter = Math.max(L(fg!), L(bg!));
  const darker = Math.min(L(fg!), L(bg!));
  const ratio = (lighter + 0.05) / (darker + 0.05);
  expect(ratio, `${selector} contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
}

test.describe("phone hero rates are labelled on the strip", () => {
  test.use({ userAgent: IPHONE, isMobile: true, hasTouch: true });

  for (const width of [360, 390]) {
    test(`the strip says Sample at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expectSampleInside(page, '[data-hero-rates="strip"]');
    });
  }
});

test.describe("desktop hero rates are labelled on the card and the ticker", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the card and the ticker say Sample at 1280", async ({ page }) => {
    await page.goto("/");
    await expectSampleInside(page, '[data-hero-rates="card"]');
    await expectSampleInside(page, '[data-hero-rates="ticker"]');
  });
});
