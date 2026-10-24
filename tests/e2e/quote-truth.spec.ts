import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";
const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as { Pool: new (config: { connectionString: string }) => { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }>; end: () => Promise<void> } };
test.skip(!hasLedger, "needs SEAM_DATABASE_URL");
const SHOTS = path.join("docs", "pr-shots", "quote-truth");
const WIDTHS = [360, 390, 430, 600, 1280] as const;
function sameMoney(left: string, right: string): boolean {
  const part = (value: string) => {
    const match = value.replace(/,/g, "").trim().match(/-?\d+(?:\.\d+)?/);
    if (!match) throw new Error(`not money: ${value}`);
    const [whole, frac = ""] = match[0].replace("-", "").split(".");
    return { neg: match[0].startsWith("-"), body: `${whole}${frac}`.replace(/^0+(?=\d)/, ""), scale: frac.length };
  };
  const a = part(left), b = part(right), scale = Math.max(a.scale, b.scale);
  const pad = (p: { body: string; scale: number }) => p.body + "0".repeat(scale - p.scale);
  return a.neg === b.neg && pad(a) === pad(b);
}
function expectSame(left: string, right: string, label: string) {
  expect(sameMoney(left, right), `${label}: ${left} vs ${right}`).toBe(true);
}
async function takeTill(page: Page) {
  const open = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me").then((r) => r.json());
    const id = String(me.user?.id ?? "");
    const session = await fetch("/api/ledger/till-session").then((r) => r.json());
    const opener = String(session.session?.openedBy ?? "");
    const mine = session.session?.status === "open" && (opener === id || opener.endsWith(":" + id));
    let balances: Record<string, string> = (await fetch("/api/ledger/till-balances").then((r) => r.json())).balances ?? {};
    if (!Object.keys(balances).length) {
      const seeded = await fetch("/api/ledger/opening-balances", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ balances: { CAD: "20000.00", USD: "8000.00" } }) });
      if (!seeded.ok) return await seeded.text();
      balances = (await fetch("/api/ledger/till-balances").then((r) => r.json())).balances ?? {};
    }
    if (mine) return "open";
    if (session.session?.status === "open") {
      const counts: Record<string, string> = {};
      for (const [c, v] of Object.entries(balances)) counts[c] = Number(v).toFixed(2);
      const handed = await fetch("/api/ledger/till-sessions/handover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: "qt-" + Date.now(), counts }) });
      return handed.ok ? "open" : await handed.text();
    }
    const res = await fetch("/api/ledger/till-sessions/open", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return res.ok || res.status === 409 ? "open" : await res.text();
  });
  expect(open, "till open").toBe("open");
}
async function openExchange(page: Page) {
  const button = () => page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button()).toBeVisible({ timeout: 30_000 });
  await takeTill(page);
  if (await page.locator(".cdos-tour-skip").isVisible().catch(() => false)) await page.locator(".cdos-tour-skip").click();
  const sessionOpen = await page.evaluate(async () => (await fetch("/api/ledger/till-session").then((r) => r.json())).session?.status === "open");
  /* The desk latches "day closed" from the session it saw at paint. Opening
     the till afterwards does not repaint that latch, so reload once. */
  if (!sessionOpen || !(await button().isEnabled())) {
    await page.reload();
    await landOnDesktop(page);
  }
  await expect(button()).toBeEnabled({ timeout: 30_000 });
  await button().click();
  await expect(page.locator(".cd-tx")).toBeVisible();
}
async function pickCurrency(page: Page, which: 0 | 1, code: string) {
  await page.locator(".cd-money button").nth(which).evaluate((el) => (el as HTMLElement).click());
  const option = page.locator("[style*='z-index: 99998'] button").filter({ hasText: new RegExp("^" + code) }).first();
  await option.evaluate((el) => (el as HTMLElement).click());
}
async function fillDeal(page: Page, amount: string, fee = "") {
  await page.locator(".cd-tx-customer input").fill("Quote Truth");
  const money = page.locator(".cd-money input").first();
  await money.fill(amount);
  await money.blur();
  if (fee) await page.locator(".cd-tx-fee").fill(fee);
  const purpose = page.locator(".cd-tx-purpose");
  if (await purpose.count()) {
    await purpose.fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
  }
}
async function showFrozenCard(page: Page) {
  const show = page.getByRole("button", { name: /Show customer the quote/i });
  await expect(show).toBeDisabled();
  await page.locator(".cd-tx-go").click();
  await expect(page.locator(".cd-tx-go")).toContainText(/Post frozen quote/, { timeout: 20_000 });
  await expect(show).toBeEnabled();
  await show.click();
  await expect(page.locator("[data-quote-face]")).toBeVisible();
}
async function postFrozen(page: Page) {
  await page.keyboard.press("Escape");
  const posted = page.waitForResponse((res) => res.url().includes("/post") && res.request().method() === "POST");
  await page.locator(".cd-tx-go").click();
  const res = await posted;
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}
type Book = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, string>[] }> };
async function tillOut(pool: Book, transactionId: string, currency: string) {
  const till = await pool.query("SELECT amount::text AS amount FROM ledger_till_movements WHERE transaction_id = $1 AND direction = 'out' AND currency = $2", [transactionId, currency]);
  return till.rows[0].amount;
}
async function withBook(page: Page, user: string, run: (pool: Book) => Promise<void>) {
  test.setTimeout(120_000);
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAtDesk(page, user);
    await run(pool);
  } finally { await pool.end(); }
}
async function topUp(page: Page, currency: string, amount: string, key: string) {
  await takeTill(page);
  const topped = await page.evaluate(async ({ currency, amount, key }) => {
    const res = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key, direction: "in", currency, amount, counterpartyType: "bank", counterpartyRef: "quote-truth", reason: `${currency} for the quote truth deal` }),
    });
    return { status: res.status, body: await res.text() };
  }, { currency, amount, key });
  expect([201, 409], topped.body).toContain(topped.status);
  await page.evaluate((code) => {
    const ccy = (window as unknown as { CDOS: { CCY: string[] } }).CDOS.CCY;
    if (ccy.indexOf(code) < 0) ccy.push(code);
  }, currency);
}
test("CAD to USD: the card, the deal, and the till pay one amount", async ({ page }) => {
  await withBook(page, "a.singh", async (pool) => {
    await openExchange(page);
    await fillDeal(page, "1000");
    await expect(page.locator(".cd-tx-receive")).toHaveText("722.10", { timeout: 20_000 });
    await expect(page.locator(".cd-tx-rate-line .cd-tx-rate-shown")).toHaveText("1 CAD = 0.722104 USD");
    const ratePaint = await page.locator(".cd-tx-rate-line .cd-tx-rate-shown").evaluate((el) => ({ size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }));
    expect(ratePaint).toEqual({ size: "14px", color: "rgb(17, 17, 17)" });
    await showFrozenCard(page);
    mkdirSync(SHOTS, { recursive: true });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 600 ? 780 : 900 });
      const face = page.locator("[data-quote-face]");
      await expect(face).toBeVisible();
      await page.screenshot({ path: path.join(SHOTS, `card-${width}.png`), fullPage: false });
      const box = await face.locator("[data-quote-rate]").boundingBox();
      const view = page.viewportSize();
      expect(box && view && box.x >= -1 && box.x + box.width <= view.width + 1, `rate fits ${width}`).toBeTruthy();
    }
    const card = (await page.locator("[data-quote-get]").innerText()).replace(/\s+/g, " ");
    const rate = (await page.locator("[data-quote-rate]").innerText()).replace(/\s+/g, " ");
    expect(card).toContain("722.10");
    expect(card).not.toContain("722.25");
    expect(rate).toContain("0.722104");
    expect(rate).not.toContain("0.722103704355");
    const body = await postFrozen(page);
    expectSame(body.outputAmount, "722.10", "posted");
    expect(String(body.rate)).toContain("0.722103704355");
    expectSame(await tillOut(pool, body.transactionId, "USD"), "722.10", "till");
    expectSame(card, "722.10", "card");
  });
});
test("USD to JPY pays whole yen on the card, the deal, and the till", async ({ page }) => {
  await withBook(page, "r.haddad", async (pool) => {
    await topUp(page, "JPY", "500000.00", "quote-truth-jpy-in");
    await openExchange(page);
    await pickCurrency(page, 0, "USD");
    await pickCurrency(page, 1, "JPY");
    await fillDeal(page, "100");
    await showFrozenCard(page);
    const card = (await page.locator("[data-quote-get]").innerText()).replace(/\s+/g, " ");
    expect(card).toMatch(/[\d,]+ JPY/);
    expect(card).not.toMatch(/\.\d/);
    const body = await postFrozen(page);
    expect(String(body.outputAmount)).not.toMatch(/\.\d*[1-9]/);
    expectSame(card, String(body.outputAmount), "jpy card");
    expectSame(String(body.outputAmount), await tillOut(pool, body.transactionId, "JPY"), "jpy till");
  });
});
test("a pay-in with a fee pays the quoted amount, and the fee is its own till movement", async ({ page }) => {
  await withBook(page, "a.singh", async (pool) => {
    await openExchange(page);
    await page.locator(".cd-tx-swap").click();
    await fillDeal(page, "100", "5.00");
    await showFrozenCard(page);
    const card = (await page.locator("[data-quote-get]").innerText()).replace(/\s+/g, " ");
    expect(card).toContain("CAD");
    const body = await postFrozen(page);
    expectSame(card, String(body.outputAmount), "fee card");
    const moves = await pool.query("SELECT direction, currency, amount::text AS amount FROM ledger_till_movements WHERE transaction_id = $1", [body.transactionId]);
    const out = moves.rows.find((row) => row.direction === "out" && row.currency === "CAD");
    const fee = moves.rows.find((row) => row.direction === "in" && row.currency === "CAD" && sameMoney(row.amount, "5.00"));
    expect(out, JSON.stringify(moves.rows)).toBeTruthy();
    expect(fee, JSON.stringify(moves.rows)).toBeTruthy();
    expectSame(String(body.outputAmount), out!.amount, "fee till");
    expectSame(String(body.feeCad), "5.00", "fee");
  });
});
test("Post stays disabled until the preview arrives", async ({ page }) => {
  test.setTimeout(90_000);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/quotes/preview", async (route) => { await gate; await route.continue(); });
  await page.setViewportSize({ width: 390, height: 780 });
  await signInAtDesk(page, "a.singh");
  await openExchange(page);
  await fillDeal(page, "1000");
  const post = page.locator(".cd-tx-go");
  await expect(post).toBeDisabled();
  await expect(page.locator(".cd-tx-receive")).not.toHaveText(/\d/);
  await expect(page.locator(".cd-tx-rate-line .cd-tx-rate-shown")).not.toHaveText(/\d/);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "loading-390.png") });
  const topAt = () => post.evaluate((el) => el.getBoundingClientRect().top);
  const top390 = await topAt();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(post).toBeDisabled();
  await expect(page.locator(".cd-tx-receive")).not.toHaveText(/\d/);
  await page.screenshot({ path: path.join(SHOTS, "loading-1280.png") });
  const top1280 = await topAt();
  release();
  await expect(page.locator(".cd-tx-receive")).toHaveText("722.10", { timeout: 20_000 });
  await expect(post).toBeEnabled();
  expect(Math.abs((await topAt()) - top1280)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(SHOTS, "head-1280.png") });
  await page.setViewportSize({ width: 390, height: 780 });
  await expect(page.locator(".cd-tx-receive")).toHaveText("722.10");
  expect(Math.abs((await topAt()) - top390)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(SHOTS, "head-390.png") });
});
test("a held text rate is the rate that posts", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "r.haddad");
  await page.evaluate(() => {
    localStorage.setItem("cdos_tg_requests_v2", JSON.stringify([{ ref: "TQ-2741", phone: "4165550142", name: "Held Rate", ccy: "USD", amount: 700, total: 1000, rate: 0.7, status: "held", kind: "quote", holdUntil: Date.now() + 3600000 }]));
  });
  await openExchange(page);
  await page.getByRole("button", { name: /Text quote/i }).click();
  await page.locator("input[placeholder='TQ-1044']").fill("TQ-2741");
  await page.getByRole("button", { name: /Fill it in/i }).click();
  await expect(page.locator(".cd-tx-rate")).toHaveValue("0.7");
  await expect(page.locator(".cd-tx-receive")).not.toHaveText(/722/);
  await page.locator(".cd-tx-purpose").fill("Personal travel");
  await page.locator(".cd-tx-source").fill("Employment income");
  await page.locator(".cd-tx-go").click();
  await expect(page.locator(".cd-tx-receive")).toHaveText("700.00", { timeout: 20_000 });
  const posted = page.waitForResponse((res) => res.url().includes("/post") && res.request().method() === "POST");
  await page.locator(".cd-tx-go").click();
  const res = await posted;
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(String(body.outputAmount)).toBe("700.00");
  expect(String(body.rate)).toContain("0.7");
  expect(String(body.rate)).not.toContain("0.722103704355");
  await signInAtDesk(page, "a.singh");
  await takeTill(page);
});
