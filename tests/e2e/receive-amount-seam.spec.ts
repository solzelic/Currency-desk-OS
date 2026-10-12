/* The cashier reads Customer receives and counts cash against it.
   That figure has to be the amount the ledger posts. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop, hasLedger } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function tillSessionOpen(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-session");
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body.session && body.session.status === "open");
  });
}

async function openNewTransaction(page: Page): Promise<void> {
  const button = () => page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button()).toBeVisible({ timeout: 30_000 });
  if (!(await tillSessionOpen(page))) {
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409 ? "open" : await res.text();
    });
    expect(opened, "the till did not open").toBe("open");
    const seen = page.waitForResponse((res) => {
      const url = res.url();
      return url.includes("/api/ledger/till-session")
        && !url.includes("/till-sessions/")
        && res.request().method() === "GET"
        && res.ok();
    });
    await page.reload();
    await seen;
    await landOnDesktop(page);
    await dismissTour(page);
    expect(await tillSessionOpen(page), "till session after open").toBe(true);
  }
  await expect(button()).toBeEnabled({ timeout: 30_000 });
  await button().click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

/* The rest of the suite republishes York's board (a 2% margin is
   enough to move 3,500 USD from 4,702.63 to 4,678.76). This test pins
   the board the cashier actually misread, then puts the previous
   publication back. */
type BoardSnap = {
  buyMargin: number;
  sellMargin: number;
  rows: Record<string, { mid: number; show?: boolean; spread?: number }>;
  order?: string[];
};

function cleanRows(
  rows: Record<string, { mid: number; show?: boolean; spread?: number }>,
  usdMid?: number,
  jpyMid?: number,
): Record<string, { mid: number; show: boolean; spread?: number }> {
  const out: Record<string, { mid: number; show: boolean; spread?: number }> = {};
  for (const [code, row] of Object.entries(rows)) {
    const clean: { mid: number; show: boolean; spread?: number } = {
      mid: code === "USD" && usdMid != null ? usdMid : code === "JPY" && jpyMid != null ? jpyMid : Number(row.mid),
      show: row.show !== false,
    };
    if (row.spread != null) clean.spread = Number(row.spread);
    out[code] = clean;
  }
  if (usdMid != null && !out.USD) out.USD = { mid: usdMid, show: true };
  if (jpyMid != null && !out.JPY) out.JPY = { mid: jpyMid, show: true };
  return out;
}

async function publishBoard(
  page: Page,
  board: { buyMargin: number; sellMargin: number; rows: Record<string, { mid: number; show?: boolean; spread?: number }>; order?: string[] },
  usdMid?: number,
  jpyMid?: number,
): Promise<{ status: number; body: string }> {
  return page.evaluate(async (payload) => {
    const res = await fetch("/api/rates/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.text() };
  }, {
    buyMargin: board.buyMargin,
    sellMargin: board.sellMargin,
    rows: cleanRows(board.rows, usdMid, jpyMid),
    ...(board.order ? { order: board.order } : {}),
  });
}

let boardBefore: BoardSnap | null = null;

async function pinQaBoard(page: Page): Promise<void> {
  const current = await page.evaluate(async () => {
    const res = await fetch("/api/rates");
    return { status: res.status, body: await res.json() };
  });
  expect(current.status, "board before the deal").toBe(200);
  expect(current.body.board?.rows?.USD?.mid, "York has no USD mid").toBeTruthy();
  boardBefore = {
    buyMargin: current.body.board.buyMargin,
    sellMargin: current.body.board.sellMargin,
    rows: current.body.board.rows,
    order: current.body.board.order,
  };
  const published = await publishBoard(page, {
    buyMargin: 0.015,
    sellMargin: 0.015,
    rows: boardBefore.rows,
    order: boardBefore.order,
  }, 1.36407, 0.00909918);
  expect(published.status, published.body).toBe(200);
}

async function restoreBoard(request: APIRequestContext): Promise<void> {
  if (!boardBefore) return;
  const saved = boardBefore;
  const login = await request.post("/api/auth/login", {
    data: { staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const restored = await request.post("/api/rates/publish", {
    data: {
      buyMargin: saved.buyMargin,
      sellMargin: saved.sellMargin,
      rows: cleanRows(saved.rows),
      ...(saved.order ? { order: saved.order } : {}),
    },
  });
  expect(restored.status(), await restored.text()).toBe(200);
  boardBefore = null;
}

/* Signs in at the shared till with the QA board. Does not post.
   A USD 3,500 we-buy pays 4,702.63 CAD out of a 25,000 opening, so
   only the viewport cases (and the yen case's one setup post) may
   call quoteUsdToCad. */
async function prepareDesk(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.addInitScript(() => {
    const key = "cdos_clients_v1";
    const cur = JSON.parse(localStorage.getItem(key) || "{}");
    cur["Amina Diallo"] = { idType: "Passport", idNum: "P4488123", idExpiry: "2030-06-01" };
    localStorage.setItem(key, JSON.stringify(cur));
  });
  await page.goto("/app");
  const funded = await page.evaluate(async () => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!login.ok) return { status: login.status, body: await login.text() };
    const res = await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00" } }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  expect([201, 409], `opening balances: ${JSON.stringify(funded)}`).toContain(funded.status);
  const opened = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status, body: await res.text() };
  });
  expect([201, 409], `till open: ${opened.body}`).toContain(opened.status);
  await pinQaBoard(page);
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("yorkfx_rates_v1");
    if (!raw) return false;
    const board = JSON.parse(raw);
    const mid = board.rows && board.rows.USD && board.rows.USD.mid;
    return typeof mid === "number" && Math.abs(mid - 1.36407) < 1e-9 && Math.abs(board.buyMargin - 0.015) < 1e-9;
  });
}

async function quoteUsdToCad(page: Page, width: number): Promise<void> {
  await prepareDesk(page, width);
  await openNewTransaction(page);
  await page.locator(".cd-tx-customer input").fill("Amina Diallo");
  await page.locator(".cd-money input").first().click();
  await page.locator(".cd-tx-swap").click();
  await expect(page.locator(".cd-tx-side")).toContainText("We buy USD");
  await page.locator(".cd-money input").first().fill("3500");
  await expect(page.getByTestId("tx-receives")).toHaveText("4,702.63");
  await expect(page.getByTestId("tx-ticket-receives")).toContainText("4,702.63");
  await page.locator(".cd-tx-purpose").fill("Personal travel");
  await page.locator(".cd-tx-source").fill("Employment income");
  await page.getByRole("button", { name: "Get server quote" }).click();
  await expect(page.getByTestId("tx-frozen")).toContainText("4,702.63");
  const frozen = await page.getByTestId("tx-frozen").innerText();
  expect(frozen, "frozen expiry").toMatch(/Expires in \d+:\d{2}$/);
  expect(frozen).not.toMatch(/[AP]M|a\.m\.|p\.m\./);
  await expect(page.locator(".cd-tx-rail")).toContainText("71.62");
  if (width <= 360) {
    const kicker = page.locator(".cd-tx-rate-line .cd-tx-kicker");
    await expect(kicker).toContainText("CAD");
    const overflow = await kicker.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "the rate line clips CAD").toBeLessThanOrEqual(1);
  }
  await expect(page.getByTestId("tx-receives")).toHaveText("4,702.63");
  await expect(page.getByTestId("tx-ticket-pays")).toContainText("3,500.00");
  const shot = process.env.SHOT_DIR;
  if (shot) {
    mkdirSync(shot, { recursive: true });
    await page.locator(".cd-tx").screenshot({ path: path.join(shot, `receive-3500-${width}.png`) });
  }
  const postedWait = page.waitForResponse((res) => res.url().includes("/api/quotes/") && res.url().endsWith("/post") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Post frozen quote" }).click();
  const postedRes = await postedWait;
  const posted = await postedRes.json();
  expect(postedRes.status(), JSON.stringify(posted)).toBe(201);
  expect(posted.outputAmount, "posted output").toBe("4702.63");
  const listed = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/transactions?limit=20");
    return res.json();
  });
  const row = (listed.transactions || []).find((tx: { quoteId?: string }) => tx.quoteId === posted.quoteId);
  expect(row, "ledger row").toBeTruthy();
  expect(row.outputAmount).toBe("4702.63");
}

test("desktop Customer receives is the posted amount for USD 3,500", async ({ page, request }) => {
  try {
    await quoteUsdToCad(page, 1280);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().click();
    await page.locator(".cd-money input").first().fill("3500");
    await expect(page.locator(".cd-tx-side")).toContainText("We sell USD");
    await expect(page.getByTestId("tx-receives")).toHaveText("2,527.36");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("2,527.36");
    const postedWait = page.waitForResponse((res) => res.url().includes("/api/quotes/") && res.url().endsWith("/post") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Post frozen quote" }).click();
    const sellRes = await postedWait;
    const sellPosted = await sellRes.json();
    expect(sellRes.status(), JSON.stringify(sellPosted)).toBe(201);
    expect(sellPosted.outputAmount).toBe("2527.36");
  } finally {
    await restoreBoard(request);
  }
});

test("phone Customer receives is the posted amount for USD 3,500", async ({ page, request }) => {
  try {
    await quoteUsdToCad(page, 390);
  } finally {
    await restoreBoard(request);
  }
});

test("narrow phone Customer receives is the posted amount for USD 3,500", async ({ page, request }) => {
  try {
    await quoteUsdToCad(page, 360);
  } finally {
    await restoreBoard(request);
  }
});

/* The menu closes itself on any scroll, including the scroll a click
   uses to bring a lower currency into view. Fire the option's own
   handler instead of scrolling the list. */
async function chooseCurrency(page: Page, which: number, code: string): Promise<void> {
  const trigger = page.locator(".cd-money").nth(which).locator("button");
  const option = () => page.getByRole("button", { name: new RegExp(`^${code}\\b`) }).last();
  await expect(async () => {
    if ((await option().count()) === 0) await trigger.click();
    await expect(option()).toBeAttached({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await option().evaluate((el: HTMLButtonElement) => el.click());
  await expect(trigger).toContainText(code);
}

/* York's shared drawer is till-01. A yen balance there has no chip on
   the count sheet, and the close waits on a currency it cannot count.
   This case sits at its own till, opened through the product's add-till
   route, and the shared drawer's currencies are read before and after. */
const SHARED_WORKSPACE = "ws-yorkville-till-01";
const YEN_TILL = "till-yen-parity";

async function asManager(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/auth/login", {
    data: { staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
}

function centsOf(value: string | undefined): number {
  const cleaned = String(value ?? "0").trim().replace(/,/g, "");
  const negative = cleaned.startsWith("-");
  const [whole, frac = ""] = cleaned.replace("-", "").split(".");
  const n = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return negative ? -n : n;
}

function leadingCents(text: string): number {
  const match = text.replace(/,/g, "").match(/-?\d+\.\d{2}/);
  if (!match) throw new Error(`no amount in ${text}`);
  return centsOf(match[0]);
}

async function sharedBalances(request: APIRequestContext): Promise<Record<string, string>> {
  await asManager(request);
  const held = await request.get("/api/ledger/till-balances", {
    headers: { "x-workspace-id": SHARED_WORKSPACE },
  });
  expect(held.ok(), await held.text()).toBeTruthy();
  return ((await held.json()).balances || {}) as Record<string, string>;
}

async function ledgerCount(page: Page): Promise<number> {
  const listed = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/transactions?limit=50");
    return res.json();
  });
  return ((listed.transactions || []) as unknown[]).length;
}

async function tillCurrencies(request: APIRequestContext, workspaceId: string): Promise<string[]> {
  await asManager(request);
  const held = await request.get("/api/ledger/till-balances", {
    headers: { "x-workspace-id": workspaceId },
  });
  expect(held.ok(), await held.text()).toBeTruthy();
  const body = await held.json();
  return Object.keys(body.balances || {}).map((code) => code.trim()).sort();
}

async function ensureYenTill(request: APIRequestContext): Promise<string> {
  await asManager(request);
  const created = await request.post("/api/desk/branches/br-yorkville/tills", {
    data: { tillId: YEN_TILL },
  });
  const body = await created.json();
  const workspaceId = body.till?.workspaceId as string | undefined;
  expect(created.ok(), JSON.stringify(body)).toBeTruthy();
  expect(workspaceId, JSON.stringify(body)).toBeTruthy();
  const opened = await request.post("/api/ledger/till-sessions/open", {
    headers: { "x-workspace-id": workspaceId! },
    data: {},
  });
  expect([201, 409], await opened.text()).toContain(opened.status());
  for (const [currency, amount, key] of [
    ["JPY", "500000.00", "yen-float-till-yen-parity"],
    ["CAD", "1.00", "cad-row-till-yen-parity"],
  ] as const) {
    const moved = await request.post("/api/ledger/till-movements", {
      headers: { "x-workspace-id": workspaceId! },
      data: {
        idempotencyKey: key,
        direction: "in",
        currency,
        amount,
        counterpartyType: "other",
        counterpartyRef: "yen parity till",
        reason: "Stock the yen-parity till so a sale can be paid out",
      },
    });
    expect(moved.status(), await moved.text()).toBe(201);
  }
  return workspaceId!;
}

/* The desk remembers which drawer this teller is standing at, and the
   quote posts to that drawer. Name it before the reload so the sheet
   and the book are the yen till, not the shared one. */
async function standAtYenTill(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript((id) => {
    localStorage.setItem("cdesk.ledger.till.m.costa", id);
  }, workspaceId);
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await page.waitForFunction(
    (id) => !!(window.CDOS && window.CDOS.Backend && window.CDOS.Backend.getWorkspace() === id),
    workspaceId,
  );
  /* The header names the yen till. Stamp the session too, so a read
     that omits the header — the ledger list after the post — asks the
     same drawer the quote was written to. */
  const stood = await page.evaluate(async (id) => {
    const resolved = await window.CDOS.Backend.selectWorkspace(id);
    window.CDOS.Backend.setWorkspace(resolved.workspaceId);
    return resolved.tillId;
  }, workspaceId);
  expect(stood).toBe(YEN_TILL);
}

async function postFrozen(page: Page, output: string, fee?: string): Promise<void> {
  const postedWait = page.waitForResponse((res) => res.url().includes("/api/quotes/") && res.url().endsWith("/post") && res.request().method() === "POST");
  await page.getByRole("button", { name: "Post frozen quote" }).click();
  const postedRes = await postedWait;
  const posted = await postedRes.json();
  expect(postedRes.status(), JSON.stringify(posted)).toBe(201);
  expect(posted.outputAmount, "posted output").toBe(output);
  if (fee) expect(posted.feeCad, "posted fee").toBe(fee);
  const listed = await page.evaluate(async () => {
    const res = await fetch("/api/ledger/transactions?limit=20");
    return res.json();
  });
  const row = (listed.transactions || []).find((tx: { quoteId?: string }) => tx.quoteId === posted.quoteId);
  expect(row, "ledger row").toBeTruthy();
  expect(row.outputAmount).toBe(output);
  if (fee) expect(row.feeCad).toBe(fee);
}

test("whole yen Customer receives is the posted amount", async ({ page, request }) => {
  let sharedBefore: string[] = [];
  try {
    await quoteUsdToCad(page, 1280);
    sharedBefore = await tillCurrencies(request, SHARED_WORKSPACE);
    const yenWorkspace = await ensureYenTill(request);
    await standAtYenTill(page, yenWorkspace);
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("yorkfx_rates_v1");
      if (!raw) return false;
      const board = JSON.parse(raw);
      const mid = board.rows && board.rows.JPY && board.rows.JPY.mid;
      return typeof mid === "number" && Math.abs(mid - 0.00909918) < 1e-12;
    });
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await expect(page.getByText("ID on file").first()).toBeVisible();
    await chooseCurrency(page, 1, "JPY");
    await expect(page.locator(".cd-tx-side")).toContainText("We sell JPY");
    await page.locator(".cd-money input").first().fill("1000");
    await expect(page.getByTestId("tx-receives")).toHaveText("108,252");
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("108,252");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("108,252");
    await expect(page.getByTestId("tx-receives")).toHaveText("108,252");
    await postFrozen(page, "108252.00");
    await asManager(request);
    const yenHeld = await request.get("/api/ledger/till-balances", {
      headers: { "x-workspace-id": yenWorkspace },
    });
    expect(yenHeld.ok(), await yenHeld.text()).toBeTruthy();
    const yenBalances = (await yenHeld.json()).balances;
    expect(yenBalances.JPY, "yen paid out of the parity till").toBe("391748.00");
    expect(yenBalances.CAD, "cad taken in at the parity till").toBe("1001.00");
  } finally {
    await restoreBoard(request);
    if (sharedBefore.length) {
      expect(await tillCurrencies(request, SHARED_WORKSPACE), "shared till currencies after the yen case").toEqual(sharedBefore);
    }
  }
});

test("a we-sell fee is cash the till takes, and the headline says so", async ({ page, request }) => {
  try {
    await prepareDesk(page, 1280);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().fill("100");
    await page.locator(".cd-tx-fee").fill("1.50");
    await expect(page.locator(".cd-tx-side")).toContainText("We sell USD");
    await expect(page.getByTestId("tx-receives")).toHaveText("72.21");
    await expect(page.getByTestId("tx-ticket-pays")).toContainText("101.50 CAD (100.00 + 1.50 fee)");
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("72.21");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("72.21");
    await expect(page.getByTestId("tx-ticket-pays")).toContainText("101.50 CAD (100.00 + 1.50 fee)");
    await page.getByRole("button", { name: "Show customer the quote" }).click();
    const presented = page.locator("div.fixed.inset-0").last();
    await expect(presented).toContainText("You give");
    await expect(presented).toContainText("101.50 CAD (100.00 + 1.50 fee)");
    await expect(presented).toContainText("You receive");
    await presented.getByRole("button", { name: "Back to desk" }).click();
    const before = await sharedBalances(request);
    const headline = (await page.getByTestId("tx-ticket-pays").innerText()).replace(/\s+/g, " ");
    await postFrozen(page, "72.21", "1.50");
    const after = await sharedBalances(request);
    expect(centsOf(after.CAD) - centsOf(before.CAD), "till CAD movement").toBe(leadingCents(headline));
    expect(centsOf(after.USD) - centsOf(before.USD), "till USD movement").toBe(-7221);
  } finally {
    await restoreBoard(request);
  }
});

test("a we-buy fee is cash the till pays out, and the headline says so", async ({ page, request }) => {
  try {
    await prepareDesk(page, 1280);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().click();
    await page.locator(".cd-tx-swap").click();
    await expect(page.locator(".cd-tx-side")).toContainText("We buy USD");
    await page.locator(".cd-money input").first().fill("100");
    await page.locator(".cd-tx-fee").fill("1.50");
    await expect(page.getByTestId("tx-receives")).toHaveText("132.86");
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("132.86 CAD (134.36 less 1.50 fee)");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("132.86 CAD (134.36 less 1.50 fee)");
    await page.getByRole("button", { name: "Show customer the quote" }).click();
    const presented = page.locator("div.fixed.inset-0").last();
    await expect(presented).toContainText("You receive");
    await expect(presented).toContainText("132.86 CAD (134.36 less 1.50 fee)");
    await presented.getByRole("button", { name: "Back to desk" }).click();
    const before = await sharedBalances(request);
    const headline = (await page.getByTestId("tx-ticket-receives").innerText()).replace(/\s+/g, " ");
    await postFrozen(page, "134.36", "1.50");
    const after = await sharedBalances(request);
    expect(centsOf(before.CAD) - centsOf(after.CAD), "till CAD movement").toBe(leadingCents(headline));
    expect(centsOf(after.USD) - centsOf(before.USD), "till USD movement").toBe(10000);
  } finally {
    await restoreBoard(request);
  }
});

test("half-up Customer receives is the posted amount, not banker's rounding", async ({ page, request }) => {
  try {
    await prepareDesk(page, 1280);
    await page.evaluate(async () => {
      const login = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" }),
      });
      if (!login.ok) throw new Error("half-up login " + login.status);
    });
    const published = await publishBoard(page, {
      buyMargin: 0,
      sellMargin: 0,
      rows: boardBefore!.rows,
      order: boardBefore!.order,
    }, 1.005);
    expect(published.status, published.body).toBe(200);
    await signInAtDesk(page, "m.costa");
    await dismissTour(page);
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("yorkfx_rates_v1");
      if (!raw) return false;
      const board = JSON.parse(raw);
      const mid = board.rows && board.rows.USD && board.rows.USD.mid;
      return typeof mid === "number" && Math.abs(mid - 1.005) < 1e-12 && Math.abs(Number(board.buyMargin)) < 1e-12;
    });
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().click();
    await page.locator(".cd-tx-swap").click();
    await expect(page.locator(".cd-tx-side")).toContainText("We buy USD");
    await page.locator(".cd-money input").first().fill("1");
    await expect(page.getByTestId("tx-receives")).toHaveText("1.01");
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("1.01");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    /* A zero margin is under the desk's 0.5% floor, so the sheet will
       not ask for a quote until the teller overrides it. */
    await page.getByRole("checkbox", { name: "Override and post below the floor" }).check();
    await page.getByPlaceholder(/Reason/).fill("Half-up parity at a zero margin");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("1.01");
    await expect(page.getByTestId("tx-receives")).toHaveText("1.01");
    await postFrozen(page, "1.01");
  } finally {
    await restoreBoard(request);
  }
});

test("an old build id is refused and nothing posts", async ({ page, request }) => {
  try {
    await prepareDesk(page, 1280);
    const sources = await page.locator("script[src]").evaluateAll((els) => els.map((el) => el.getAttribute("src") || ""));
    expect(sources.some((src) => /\/web\/app\/quote-terms\.min\.js\?v=[0-9a-f]+/.test(src)), sources.join(" ")).toBeTruthy();
    expect(sources.some((src) => /\/web\/app\/os\.js\?v=[0-9a-f]+/.test(src)), sources.join(" ")).toBeTruthy();
    const before = await ledgerCount(page);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().fill("80");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    const build = await page.locator('meta[name="currencydesk-build"]').getAttribute("content");
    expect(build).toBeTruthy();
    await page.evaluate(() => document.querySelector('meta[name="currencydesk-build"]')?.setAttribute("content", "stale-build"));
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-reload")).toContainText("This screen is out of date. Reload to continue.");
    await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
    await expect(page.getByTestId("tx-frozen")).toHaveCount(0);
    expect(await ledgerCount(page), "a refused quote posts nothing").toBe(before);
    await page.locator(".cd-tx-cancel").click();
    await page.evaluate((id) => document.querySelector('meta[name="currencydesk-build"]')?.setAttribute("content", id || ""), build);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().fill("80");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toBeVisible();
    await page.evaluate(() => document.querySelector('meta[name="currencydesk-build"]')?.setAttribute("content", "stale-build"));
    await page.getByRole("button", { name: "Post frozen quote" }).click();
    await expect(page.getByTestId("tx-reload")).toContainText("This screen is out of date. Reload to continue.");
    expect(await ledgerCount(page), "a refused post writes nothing").toBe(before);
  } finally {
    await restoreBoard(request);
  }
});

test("the picker hides three-decimal currencies and a yen fraction is not READY", async ({ page, request }) => {
  try {
    await prepareDesk(page, 1280);
    await page.evaluate(() => {
      const cfg = JSON.parse(localStorage.getItem("yorkfx_rates_v1") || "{}");
      cfg.rows = cfg.rows || {};
      cfg.rows.KWD = { mid: 0.44, show: true, spread: 0.015 };
      cfg.rows.BHD = { mid: 3.6, show: true, spread: 0.015 };
      localStorage.setItem("yorkfx_rates_v1", JSON.stringify(cfg));
    });
    await openNewTransaction(page);
    await page.locator(".cd-money input").first().fill("1");
    const trigger = page.locator(".cd-money").first().locator("button");
    await trigger.click();
    await expect(page.getByRole("button", { name: /^KWD\b/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^BHD\b/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^JPY\b/ }).last().evaluate((el: HTMLButtonElement) => el.click());
    await expect(trigger).toContainText("JPY");
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().fill("1000.5");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await expect(page.getByText("Yen has no decimals.")).toBeVisible();
    await expect(page.getByTestId("tx-checklist")).toHaveText("NOT PRICED");
    await expect(page.getByTestId("tx-checklist")).not.toHaveText(/READY/);
    await expect(page.locator(".cd-tx")).not.toContainText("invalid money");
    await chooseCurrency(page, 0, "EUR");
    await chooseCurrency(page, 1, "GBP");
    await expect(page.locator(".cd-tx-side")).toHaveText("Exchange EUR for GBP");
    await expect(page.locator(".cd-tx-side")).not.toContainText(/cross/i);
  } finally {
    await restoreBoard(request);
  }
});

test.describe("a frozen quote counts down outside Toronto", () => {
  test.use({ timezoneId: "Pacific/Kiritimati" });
  test("shows the time left, then disables Post", async ({ page, request }) => {
    try {
      await prepareDesk(page, 1280);
      expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Pacific/Kiritimati");
      await page.clock.install();
      await openNewTransaction(page);
      await page.locator(".cd-tx-customer input").fill("Amina Diallo");
      await page.locator(".cd-money input").first().fill("40");
      await page.locator(".cd-tx-purpose").fill("Personal travel");
      await page.locator(".cd-tx-source").fill("Employment income");
      const before = await ledgerCount(page);
      await page.getByRole("button", { name: "Get server quote" }).click();
      const frozen = page.getByTestId("tx-frozen");
      await expect(frozen).toHaveText(/Expires in \d+:\d{2}$/);
      await expect(frozen).not.toContainText(/[AP]M|a\.m\.|p\.m\./);
      await page.clock.fastForward(180_000);
      await expect(frozen).toHaveText("Quote expired. Get a new rate.");
      await expect(page.getByRole("button", { name: "Post frozen quote" })).toBeDisabled();
      expect(await ledgerCount(page), "an expired quote posts nothing").toBe(before);
    } finally {
      await restoreBoard(request);
    }
  });
});
