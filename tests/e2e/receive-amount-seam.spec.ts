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
  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  await openNewTransaction(page);
  await page.waitForFunction(() => {
    const raw = localStorage.getItem("yorkfx_rates_v1");
    if (!raw) return false;
    const board = JSON.parse(raw);
    return !!(board.rows && board.rows.USD && board.rows.USD.mid);
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
});

test("phone Customer receives is the posted amount for USD 3,500", async ({ page }) => {
  await quoteUsdToCad(page, 390);
});
