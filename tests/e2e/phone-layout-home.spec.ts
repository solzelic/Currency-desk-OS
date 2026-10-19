import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, path: "/" | "/compliance" | "/m") {
  const origin = process.env.LAYOUT_ORIGIN;
  const map = { "/": "/web/index.html", "/compliance": "/web/compliance.html", "/m": "/web/mobile.html" };
  await page.goto(origin ? origin + map[path] : path, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
}

function boxOf(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  });
}

test("stacks the desktop page below 640 and keeps tap targets at 44px", async ({ page }) => {
  const fails: string[] = [];
  const note = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };

  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, "/");

  const payoff = page.getByText("Customers who find you", { exact: true });
  const payoffClip = await payoff.evaluate((el) => {
    const grid = el.closest("div");
    let node: HTMLElement | null = el.parentElement;
    let clip: HTMLElement | null = null;
    while (node) {
      if (getComputedStyle(node).overflow !== "visible") clip = node;
      node = node.parentElement;
    }
    const er = el.getBoundingClientRect();
    const cr = (clip ?? grid)!.getBoundingClientRect();
    const cols = getComputedStyle(el.closest("div")!.parentElement!.parentElement!).gridTemplateColumns;
    return { cut: er.right > cr.right + 1 || er.bottom > cr.bottom + 1, cols, text: el.textContent };
  });
  note(!payoffClip.cut && !payoffClip.cols.includes(" "), "payoff label clipped or still in columns: " + JSON.stringify(payoffClip));

  const oldCards = page.locator("[data-scene='oldway'] h3");
  const third = await oldCards.nth(2).boundingBox();
  note(!!third && third.x >= 0 && third.x + third.width <= 360, "old-way third card off the 360 viewport: " + JSON.stringify(third));

  await page.setViewportSize({ width: 639, height: 800 });
  const cols639 = await page.locator("[data-scene='oldway'] h3").first().evaluate((el) => {
    const grid = el.parentElement!.parentElement!;
    return getComputedStyle(grid).gridTemplateColumns;
  });
  note(!cols639.trim().includes(" "), "old-way still multi-column at 639: " + cols639);
  const payoff639 = await page.getByText("Margin kept", { exact: true }).evaluate((el) => {
    let node: HTMLElement | null = el.parentElement;
    while (node && getComputedStyle(node).display !== "grid") node = node.parentElement;
    return node ? getComputedStyle(node).gridTemplateColumns : "missing";
  });
  note(!payoff639.trim().includes(" "), "payoff still multi-column at 639: " + payoff639);

  await page.setViewportSize({ width: 360, height: 800 });
  const founding = page.getByRole("link", { name: "Get early access" }).last();
  const foundingLines = await founding.evaluate((el) => el.querySelector("span")?.getClientRects().length ?? 0);
  note(foundingLines === 1, "founding CTA wraps to " + foundingLines + " lines");

  const card = await page.locator("[data-hero-rates='card']").boundingBox();
  note(!!card && card.x >= -1 && card.x + card.width <= 361, "sample rates card misses the 360 width: " + JSON.stringify(card));
  const chromeVisible = await page.locator("[data-hero-rates='card']").getByText("app.currencydeskos.com").isVisible();
  note(!chromeVisible, "hero window chrome still visible at 360");

  const rail = page.locator("[data-rail]", { hasText: "Cheque cashing" });
  await rail.click();
  await rail.getByRole("button", { name: "Read more" }).click();
  const demoLines = await page.getByRole("link", { name: "See a demo" }).evaluate((el) => el.getClientRects().length);
  note(demoLines === 1, "SEE A DEMO wraps to " + demoLines + " lines");

  const tap = async (label: string, loc: ReturnType<Page["locator"]>) => {
    const target = loc.first();
    const b = await target.boundingBox().catch((error: Error) => error.message);
    if (typeof b === "string") { fails.push(label + " " + b); return; }
    note(!!b && b.width >= 44 && b.height >= 44, label + " tap " + JSON.stringify(b));
  };
  await tap("read more", rail.getByRole("button", { name: "Read more" }));
  await tap("show all", page.getByRole("button", { name: /Show all/ }));
  await tap("monthly", page.getByRole("button", { name: "Monthly" }));
  await tap("annual", page.getByRole("button", { name: /Annual/ }));
  await tap("pricing cta", page.locator("#pricing a").first());
  await tap("apply", page.getByRole("link", { name: "Apply for access" }));
  await tap("footer link", page.locator("[data-footer-cols] a").first());

  await page.setViewportSize({ width: 500, height: 800 });
  await tap("nav cta", page.locator("[data-nav-cta]"));

  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, "/compliance");
  await tap("back to site", page.getByRole("link", { name: "Back to site" }));
  await tap("compliance cta", page.getByRole("link", { name: "Get early access" }));

  await open(page, "/m");
  const ticks = page.locator("button[aria-label]:not([aria-label='Previous']):not([aria-label='Next']):not([aria-label='AI copilot'])");
  const tickCount = await ticks.count();
  note(tickCount === 8, "expected 8 feature ticks, saw " + tickCount);
  for (let i = 0; i < tickCount; i++) await tap("feature tick " + i, ticks.nth(i));

  expect(fails, fails.join("\n")).toEqual([]);
});
