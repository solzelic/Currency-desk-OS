/* A 1,000 CAD deal charges the service fee on top. The quote card,
   the receipt, and the saved deal all say 2.50 and 1,002.50. */
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop, ledger } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const FEE_LINE = "Service fee: CAD 2.50, added to the total";
const PAY_LINE = "You pay: CAD 1,002.50";
const DOLLAR_FEE = "Service fee: $2.50, added to the total";
const DOLLAR_PAY = "You pay: $1,002.50";

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastOf(fg: string, bg: string) {
  const read = (color: string) => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(color);
    const [r, g, b, a] = match[1].split(",").map((part) => Number(part.trim()));
    return { r, g, b, a: a == null ? 1 : a };
  };
  const back = read(bg);
  const front = read(fg);
  const over = front.a < 1
    ? {
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
      }
    : front;
  const lum = (rgb: { r: number; g: number; b: number }) =>
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  const light = Math.max(lum(over), lum(back));
  const dark = Math.min(lum(over), lum(back));
  return (light + 0.05) / (dark + 0.05);
}

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function openDeal(page: Page) {
  const button = () => page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button()).toBeEnabled({ timeout: 30_000 });
  await button().click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

test("a 1,000 CAD deal shows the fee on top on the card, the receipt, and the till", async ({ page }) => {
  test.setTimeout(120_000);
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  const book = ledger(page);
  await book.ensureOpeningBalances({ CAD: "25000.00", USD: "12000.00" });
  await page.evaluate(async () => {
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (!opened.ok && opened.status !== 409) throw new Error(await opened.text());
  });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  const topped = await page.evaluate(async () => {
    const held = await fetch("/api/ledger/till-balances", { credentials: "same-origin" }).then((r) => r.json());
    const need: Record<string, number> = { USD: 2000, CAD: 1 };
    const notes: string[] = [];
    for (const currency of Object.keys(need)) {
      const have = Number(held.balances?.[currency] ?? 0);
      if (have >= need[currency]) continue;
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          idempotencyKey: `fee-seam-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount: (need[currency] - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "seam-fixture",
          reason: "Cash so this desk can sell US dollars",
        }),
      });
      notes.push(answer.ok ? `${currency}:ok` : `${currency}:${answer.status} ${await answer.text()}`);
    }
    return notes.length ? notes.join(" · ") : "ok";
  });
  expect(topped).toBe("ok");
  const before = Number((await book.till()).CAD ?? 0);

  await openDeal(page);
  await page.locator(".cd-money input").first().fill("1000");
  await page.locator(".cd-tx-fee").fill("2.50");
  await expect(page.locator(".cd-tx-ticket")).toContainText(FEE_LINE);
  await expect(page.locator(".cd-tx-ticket")).toContainText(PAY_LINE);

  const show = page.getByRole("button", { name: "Show customer the quote" });
  await expect(show).toBeEnabled();
  await show.click();
  const quote = page.getByTestId("customer-quote");
  await expect(quote).toContainText(FEE_LINE);
  await expect(quote).toContainText(PAY_LINE);
  await expect(quote).not.toContainText(/Includes/i);
  await expect(quote).not.toContainText("\u2014");
  await expect(quote).not.toContainText("\u2013");
  const colors = await quote.getByText(FEE_LINE).evaluate((el) => {
    const fg = getComputedStyle(el).color;
    let node: Element | null = el;
    let bg = "rgba(0, 0, 0, 0)";
    while (node) {
      const c = getComputedStyle(node).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        bg = c;
        break;
      }
      node = node.parentElement;
    }
    return { fg, bg };
  });
  expect(contrastOf(colors.fg, colors.bg)).toBeGreaterThanOrEqual(4.5);
  const back = quote.getByRole("button", { name: "Back to desk" });
  const box = await back.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);

  if (process.env.FEE_SHOTS === "1") {
    for (const width of [360, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: width < 500 ? 800 : 900 });
      await page.screenshot({ path: `docs/pr-shots/fee-on-top/quote-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  await back.click();
  await expect(quote).toBeHidden();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await page.getByPlaceholder("Type a name").fill("Ada Fee");
  await page.locator(".cd-tx-purpose").fill("Travel");
  await page.locator(".cd-tx-source").fill("Salary");
  await page.getByRole("button", { name: "Get server quote" }).click();
  await page.getByRole("button", { name: "Post frozen quote" }).click();
  const saved = page.getByTestId("saved-deal-fee");
  await expect(saved).toBeVisible({ timeout: 20_000 });
  await expect(saved).toContainText(FEE_LINE);
  await expect(saved).toContainText(PAY_LINE);
  const ref = (await page.locator(".tx-detail-ref").innerText()).trim();

  await page.getByRole("button", { name: "Receipt" }).click();
  const receipt = page.getByTestId("receipt-fee");
  await expect(receipt).toContainText(FEE_LINE);
  await expect(receipt).toContainText(PAY_LINE);

  const deal = await page.evaluate(async (wanted) => {
    const body = await fetch("/api/ledger/transactions?limit=20", { credentials: "same-origin" }).then((r) => r.json());
    return (body.transactions || []).find((row: { transactionRef?: string }) => row.transactionRef === wanted) || null;
  }, ref);
  expect(deal.feeCad).toBe("2.50");
  expect(deal.inputAmount).toBe("1000.00");
  const single = await page.evaluate(() => window.CDOS.feeOnTopCopy({
    fee: 2.5, principal: 1000, currency: "CAD", payCurrency: "CAD", currencies: ["CAD"],
  }));
  expect(single).toEqual({ feeLine: DOLLAR_FEE, payLine: DOLLAR_PAY });
  await expect.poll(async () => Number((await book.till()).CAD ?? 0), { timeout: 15_000 }).toBeCloseTo(before + 1002.5, 2);
});
