/* The cashier reads Customer receives and counts cash against it.
   That figure has to be the amount the ledger posts. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
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

async function restoreBoard(page: Page): Promise<void> {
  if (!boardBefore) return;
  const saved = boardBefore;
  boardBefore = null;
  await page.evaluate(async () => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!login.ok) throw new Error("restore login " + login.status);
  });
  const restored = await publishBoard(page, saved);
  expect(restored.status, restored.body).toBe(200);
}

async function quoteUsdToCad(page: Page, width: number): Promise<void> {
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
  const yen = await page.evaluate(async () => {
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!opened.ok && opened.status !== 409) return { step: "open", status: opened.status, body: await opened.text() };
    const res = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "yen-float-receive-parity",
        direction: "in",
        currency: "JPY",
        amount: "500000.00",
        counterpartyType: "other",
        counterpartyRef: "yen float",
        reason: "Stock yen so a sale can be counted out",
      }),
    });
    return { step: "float", status: res.status, body: await res.text() };
  });
  expect(yen.status, `yen float: ${yen.body}`).toBe(201);
  await pinQaBoard(page);
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await openNewTransaction(page);
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("yorkfx_rates_v1");
    if (!raw) return false;
    const board = JSON.parse(raw);
    const mid = board.rows && board.rows.USD && board.rows.USD.mid;
    return typeof mid === "number" && Math.abs(mid - 1.36407) < 1e-9 && Math.abs(board.buyMargin - 0.015) < 1e-9;
  });
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
  expect(frozen, "frozen expiry").toMatch(/Expires \d{1,2}:\d{2} [AP]M$/);
  expect(frozen).not.toMatch(/a\.m\.|p\.m\.|\d:\d{2}:\d{2}/);
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

test("desktop Customer receives is the posted amount for USD 3,500", async ({ page }) => {
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
    await restoreBoard(page);
  }
});

test("phone Customer receives is the posted amount for USD 3,500", async ({ page }) => {
  try {
    await quoteUsdToCad(page, 390);
  } finally {
    await restoreBoard(page);
  }
});

test("narrow phone Customer receives is the posted amount for USD 3,500", async ({ page }) => {
  try {
    await quoteUsdToCad(page, 360);
  } finally {
    await restoreBoard(page);
  }
});

async function chooseCurrency(page: Page, which: number, code: string): Promise<void> {
  await page.locator(".cd-money").nth(which).locator("button").click();
  await page.locator("button").filter({ hasText: new RegExp(`^${code}\\b`) }).last().click();
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

test("whole yen Customer receives is the posted amount", async ({ page }) => {
  try {
    await quoteUsdToCad(page, 1280);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
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
  } finally {
    await restoreBoard(page);
  }
});

test("a we-sell fee stays off the amount the customer receives", async ({ page }) => {
  try {
    await quoteUsdToCad(page, 1280);
    await openNewTransaction(page);
    await page.locator(".cd-tx-customer input").fill("Amina Diallo");
    await page.locator(".cd-money input").first().fill("100");
    await page.locator(".cd-tx-fee").fill("1.50");
    await expect(page.locator(".cd-tx-side")).toContainText("We sell USD");
    await expect(page.getByTestId("tx-receives")).toHaveText("72.21");
    await expect(page.getByTestId("tx-ticket-receives")).toContainText("72.21");
    await page.locator(".cd-tx-purpose").fill("Personal travel");
    await page.locator(".cd-tx-source").fill("Employment income");
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("72.21");
    await expect(page.getByTestId("tx-receives")).toHaveText("72.21");
    await postFrozen(page, "72.21", "1.50");
  } finally {
    await restoreBoard(page);
  }
});

test("half-up Customer receives is the posted amount, not banker's rounding", async ({ page }) => {
  try {
    await quoteUsdToCad(page, 1280);
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
    await page.getByRole("button", { name: "Get server quote" }).click();
    await expect(page.getByTestId("tx-frozen")).toContainText("1.01");
    await expect(page.getByTestId("tx-receives")).toHaveText("1.01");
    await postFrozen(page, "1.01");
  } finally {
    await restoreBoard(page);
  }
});
