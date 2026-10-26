/* Ledger list and deal detail on the one clock.
   The stored date and time are wrong on purpose. The instant is
   2026-06-18 19:43 UTC, which is 3:43 pm on the Toronto civil day.
   The browser zone is UTC so a local slice would miss that day.
   The row is opened by LT-CLK-001. Another deal can show the same
   3:43 pm, and the first time text is then the wrong row. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, signInAtDesk, landOnDesktop, type Page } from "./fixtures";

const DIR = path.join(process.cwd(), "docs/pr-shots/desk-clock");
const WIDTHS = [360, 390, 430, 600, 1280];
const PLANTED_REF = "LT-CLK-001";
const NIGHT_AT = Date.parse("2026-06-18T19:43:00.000Z");

test.use({ timezoneId: "UTC" });

type Deal = Record<string, unknown>;

function nightDeal(): Deal {
  return {
    id: "clk1", ref: PLANTED_REF, date: "2026-06-17", time: "19:43", at: NIGHT_AT,
    customer: "Night Desk", type: "Currency Exchange",
    inCcy: "CAD", inAmt: 100, rate: 1.4, outCcy: "USD", outAmt: 70, fee: 2,
    teller: "A. Singh", status: "posted",
    thread: [{ ts: "2026-06-18 23:43:00", at: NIGHT_AT, user: "A. Singh", text: "Night note" }],
  };
}

/* Same Toronto minute, later book date, so it sorts above the planted row. */
function sameMinuteDeal(): Deal {
  return {
    id: "clk-same", ref: "LT-CLK-SAME", date: "2026-10-26", time: "15:43",
    at: Date.parse("2026-10-26T19:43:00.000Z"),
    customer: "Same Minute", type: "Currency Exchange",
    inCcy: "CAD", inAmt: 40, rate: 1.4, outCcy: "USD", outAmt: 28, fee: 1,
    teller: "A. Singh", status: "posted", thread: [],
  };
}

function plantedTime(win: ReturnType<Page["locator"]>) {
  return win.locator("tr.cd-row", { hasText: PLANTED_REF }).getByText("3:43 pm").first();
}

async function plant(page: Page, extra: Deal[] = []): Promise<void> {
  await page.evaluate((book) => {
    const raw = JSON.parse(localStorage.getItem("cdos_settings") || "{}");
    raw.timeFormat = "12h";
    raw.timezone = "America/Toronto";
    localStorage.setItem("cdos_settings", JSON.stringify(raw));
    localStorage.setItem("cdos_rows_v1", JSON.stringify(book));
  }, [nightDeal(), ...extra]);
}

async function shot(page: Page, name: string, width: number): Promise<void> {
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(DIR, `${name}-${width}.png`) });
}

async function open(page: Page, id: string) {
  await page.evaluate((app) => (window as unknown as { CDOS: { openApp: (name: string) => void } }).CDOS.openApp(app), id);
  return page.locator("#desktop .win.show.active").first();
}

for (const width of WIDTHS) {
  test(`desk clock surfaces at ${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    mkdirSync(DIR, { recursive: true });
    await page.clock.install({ time: new Date("2026-06-18T19:43:00Z") });
    await page.setViewportSize({ width, height: 800 });
    await signInAtDesk(page);
    await plant(page);
    await page.reload();
    await landOnDesktop(page);
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await expect(page.locator(".cdos-tour")).toHaveCount(0);
    if (width > 430) await expect(page.locator(".mb-clock")).toContainText("3:43 pm");
    await shot(page, "menubar", width);

    const win = await open(page, "ledger");
    const clock = plantedTime(win);
    await clock.scrollIntoViewIfNeeded();
    await expect(clock).toBeVisible();
    await expect(win.getByText("2026-06-18").first()).toBeVisible();
    const rowH = await clock.evaluate((el) => el.closest("tr")?.getBoundingClientRect().height || 0);
    expect(rowH).toBeGreaterThanOrEqual(44);
    expect((await readContrast(clock)).ratio).toBeGreaterThanOrEqual(4.5);
    await shot(page, "ledger", width);
    await win.getByRole("button", { name: "Records", exact: true }).click();
    await shot(page, "records", width);
    await win.getByRole("button", { name: "Compliance", exact: true }).click();
    await expect(win.getByText("Compliance workspace")).toBeVisible();
    await shot(page, "compliance", width);
    await win.getByRole("button", { name: "Records", exact: true }).click();
    await clock.click();
    const detail = page.locator(".tx-detail-head");
    await expect(detail).toContainText(PLANTED_REF);
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
          sheet.addEventListener("transitionend", done);
          function done() { if (idle()) resolve(); }
          setTimeout(resolve, 700);
        });
      }
    });
    await page.waitForTimeout(200);
    const sheet = detail.locator("xpath=..");
    await expect(sheet).toContainText("2026-06-18 3:43 pm");
    await expect(sheet).not.toContainText("23:43");
    const deal = await readContrast(detail.getByText("3:43 pm").first());
    expect(deal.ratio).toBeGreaterThanOrEqual(4.5);
    await shot(page, "detail", width);

    const dash = await open(page, "dashboard");
    await expect(dash.getByText("Good afternoon")).toBeVisible();
    await shot(page, "dashboard", width);
    const reports = await open(page, "reports");
    await shot(page, "reports", width);
    await reports.getByRole("button", { name: /Transaction Register/ }).click();
    await expect(reports.getByText(/Generated 2026-06-18/)).toBeVisible();
    await shot(page, "generated", width);
    await open(page, "telegraph");
    await shot(page, "telegraph", width);
  });
}

test("same 3:43 pm on another deal still opens the planted row", async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install({ time: new Date("2026-06-18T19:43:00Z") });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  await plant(page, [sameMinuteDeal()]);
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.locator(".cdos-tour")).toHaveCount(0);
  const win = await open(page, "ledger");
  const decoy = win.locator("tr.cd-row", { hasText: "LT-CLK-SAME" });
  const planted = win.locator("tr.cd-row", { hasText: PLANTED_REF });
  await expect(decoy.getByText("3:43 pm").first()).toBeVisible();
  await expect(planted.getByText("3:43 pm").first()).toBeVisible();
  await expect(planted).toContainText("2026-06-18");
  const firstClock = win.locator("tr.cd-row", { hasText: "3:43 pm" }).first();
  await expect(firstClock).not.toContainText(PLANTED_REF);
  await plantedTime(win).click();
  const detail = page.locator(".tx-detail-head");
  await expect(detail).toContainText(PLANTED_REF);
  await expect(detail).toContainText("3:43 pm");
  await expect(detail).toContainText("2026-06-18");
  await expect(detail).not.toContainText("LT-CLK-SAME");
});

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
