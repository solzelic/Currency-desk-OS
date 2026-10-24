/* Ledger list and deal detail on the one clock.
   The stored date and time are wrong on purpose. The instant is
   2026-06-18 19:43 UTC, which is 3:43 pm on the Toronto civil day.
   The browser zone is UTC so a local slice would miss that day. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, signInAtDesk, landOnDesktop, type Page } from "./fixtures";

const DIR = path.join(process.cwd(), "docs/pr-shots/desk-clock");
const WIDTHS = [360, 390, 430, 1280];

test.use({ timezoneId: "UTC" });

async function plant(page: Page): Promise<void> {
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.timeFormat = "12h";
    raw.timezone = "America/Toronto";
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    localStorage.setItem("cdos_rows_v1", JSON.stringify([{
      id: "clk1", ref: "LT-CLK-001", date: "2026-06-17", time: "19:43",
      at: Date.parse("2026-06-18T19:43:00.000Z"),
      customer: "Night Desk", type: "Currency Exchange",
      inCcy: "CAD", inAmt: 100, rate: 1.4, outCcy: "USD", outAmt: 70, fee: 2,
      teller: "A. Singh", status: "posted", thread: [],
    }]));
  });
}

for (const width of WIDTHS) {
  test(`ledger and deal at ${width}`, async ({ page }) => {
    mkdirSync(DIR, { recursive: true });
    await page.clock.install({ time: new Date("2026-06-18T19:43:00Z") });
    await page.setViewportSize({ width, height: 800 });
    await signInAtDesk(page);
    await plant(page);
    await page.reload();
    await landOnDesktop(page);
    await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("ledger"));
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await expect(page.locator(".cdos-tour")).toHaveCount(0);
    const win = page.locator("#desktop .win.show.active").first();
    const clock = win.getByText("3:43 pm").first();
    await clock.scrollIntoViewIfNeeded();
    await expect(clock).toBeVisible();
    await expect(win.getByText("2026-06-18").first()).toBeVisible();
    if (width > 430) await expect(page.locator(".mb-clock")).toContainText("3:43 pm");
    await page.waitForTimeout(350);
    const list = await readContrast(clock);
    console.log(`ledger ${width} ${list.ratio.toFixed(2)}:1 ${list.color} on ${list.background}`);
    expect(list.ratio, `ledger ${width} ${list.color} on ${list.background}`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: path.join(DIR, `ledger-${width}.png`) });
    await clock.click();
    const detail = page.locator(".tx-detail-head");
    await expect(detail).toContainText("3:43 pm");
    await expect(detail).toContainText("2026-06-18");
    await detail.evaluate(async (head) => {
      const sheet = head.parentElement;
      if (!sheet) return;
      const idle = () => {
        const s = getComputedStyle(sheet);
        const opacity = parseFloat(s.opacity);
        const m = s.transform;
        return opacity >= 0.99 && (m === "none" || m === "matrix(1, 0, 0, 1, 0, 0)");
      };
      if (!idle()) {
        await new Promise<void>((resolve) => {
          const done = () => { if (idle()) resolve(); };
          sheet.addEventListener("transitionend", done);
          setTimeout(resolve, 700);
        });
      }
    });
    await page.waitForTimeout(200);
    const deal = await readContrast(detail.getByText("3:43 pm").first());
    console.log(`deal ${width} ${deal.ratio.toFixed(2)}:1 ${deal.color} on ${deal.background}`);
    expect(deal.ratio, `deal ${width} ${deal.color} on ${deal.background}`).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: path.join(DIR, `detail-${width}.png`) });
  });
}

async function readContrast(node: ReturnType<Page["locator"]>): Promise<{ ratio: number; color: string; background: string }> {
  return node.evaluate((el) => {
    const parse = (c: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return { r: 255, g: 255, b: 255, a: 1 };
      const p = m[1].split(",").map((s) => parseFloat(s.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const over = (fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number; a: number }) => {
      const a = fg.a + bg.a * (1 - fg.a);
      if (!a) return bg;
      return {
        r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
        g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
        b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
        a,
      };
    };
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) {
      const paint = parse(getComputedStyle(chain[i]).backgroundColor);
      if (paint.a > 0) bg = over(paint, bg);
    }
    const solid = over(parse(getComputedStyle(el).color), bg);
    const hi = Math.max(lum(solid), lum(bg));
    const lo = Math.min(lum(solid), lum(bg));
    const hex = (c: { r: number; g: number; b: number }) => "#" + [c.r, c.g, c.b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
    return { ratio: (hi + 0.05) / (lo + 0.05), color: hex(solid), background: hex(bg) };
  });
}
