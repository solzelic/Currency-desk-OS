/* A 1,000 CAD exchange with a 2.50 fee. The quote, the receipt, and
   the till all name that fee and a total of 1,002.50. */
import { mkdirSync } from "node:fs";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/service-fee";
const FEE = "Service fee: CAD 2.50, added to the total";
const PAY = "You pay: CAD 1002.50";
const flat = (text: string) => text.replace(/(\d),(\d)/g, "$1$2");

/* Post as the person who already holds the till. Taking it over
   leaves the next file unable to post. */
async function quoteTeller(request: APIRequestContext): Promise<string> {
  const login = async (staffId: string) => {
    const res = await request.post("/api/auth/login", {
      data: { staffId, password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(res.ok(), `login ${staffId}`).toBe(true);
  };
  const session = async () => {
    const res = await request.get("/api/ledger/till-session");
    expect(res.ok()).toBe(true);
    return (await res.json()) as { session?: { status?: string; openedBy?: string } };
  };
  const usd = async () => {
    const res = await request.get("/api/ledger/till-balances");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { balances?: Record<string, string> };
    return Number(body.balances?.USD ?? 0);
  };
  const topUp = async (have: number) => {
    const answer = await request.post("/api/ledger/till-movements", {
      data: {
        idempotencyKey: `service-fee-usd-${Date.now()}`,
        direction: "in",
        currency: "USD",
        amount: (5000 - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "service-fee",
        reason: "Float so the exchange can pay the dollars",
      },
    });
    expect(answer.ok(), await answer.text()).toBe(true);
  };
  await login("a.singh");
  const current = await session();
  const opener = String(current.session?.openedBy ?? "");
  const staffId = opener.includes(":") ? opener.slice(opener.lastIndexOf(":") + 1) : opener;
  const have = await usd();
  if (current.session?.status !== "open") {
    if (have < 2500) {
      const opened = await request.post("/api/ledger/till-sessions/open", { data: {} });
      expect(opened.ok() || opened.status() === 409, await opened.text()).toBe(true);
      await topUp(have);
      return "a.singh";
    }
    return "m.costa";
  }
  if (have < 2500) {
    await login(staffId || "a.singh");
    await topUp(have);
  }
  return staffId || "m.costa";
}

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function cadBalance(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-balances");
    const body = await res.json();
    return Number(body.balances?.CAD ?? NaN);
  });
}

async function openDeal(page: Page, staffId: string) {
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  const button = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button).toBeVisible({ timeout: 30_000 });
  if (!(await page.evaluate(async () => {
    const res = await fetch("/api/ledger/till-session");
    if (!res.ok) return false;
    const body = await res.json();
    return !!(body.session && body.session.status === "open");
  }))) {
    const opened = await page.evaluate(async () => {
      const res = await fetch("/api/ledger/till-sessions/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return res.ok || res.status === 409;
    });
    expect(opened).toBe(true);
    await page.reload();
    await landOnDesktop(page);
    await dismissTour(page);
  }
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await dismissTour(page);
}

test("the quote, the receipt, and the till agree on the fee and the total", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  const teller = await quoteTeller(request);
  await page.addInitScript(() => {
    const raw = localStorage.getItem("cdos_clients_v1");
    const clients = raw ? JSON.parse(raw) : {};
    const prior = clients["Lina Farah"] || {};
    clients["Lina Farah"] = Object.assign(prior, {
      idType: prior.idType || "Passport",
      idNum: prior.idNum || "HG847291",
      idExpiry: prior.idExpiry || "2032-04-01",
    });
    localStorage.setItem("cdos_clients_v1", JSON.stringify(clients));
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDeal(page, teller);
  await page.locator(".cd-tx-customer input").fill("Lina");
  await page.locator(".cd-tx-suggest button", { hasText: "Lina Farah" }).click();
  const amount = page.locator(".cd-money input").first();
  await amount.fill("1000");
  await amount.blur();
  const fee = page.locator(".cd-tx-fee");
  await fee.fill("2.50");
  await fee.blur();
  const show = page.getByRole("button", { name: "Show customer the quote" });
  await show.scrollIntoViewIfNeeded();
  await show.click();
  await expect(page.getByText(FEE)).toBeVisible();
  await expect(page.getByText("You pay: CAD 1,002.50")).toBeVisible();
  await expect(page.getByText(/Includes\b.{0,80}fee/i)).toHaveCount(0);

  mkdirSync(SHOTS, { recursive: true });
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    const shot = `${SHOTS}/fee_${width}.png`;
    await page.screenshot({ path: shot });
    await testInfo.attach(`service-fee-${width}`, { path: shot, contentType: "image/png" });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Back to desk" })).toBeHidden();
  await page.locator(".cd-tx-purpose").fill("travel");
  await page.locator(".cd-tx-source").fill("salary");
  const before = await cadBalance(page);
  const quoted = page.waitForResponse(
    (res) => res.url().includes("/api/quotes") && !res.url().includes("/post") && res.request().method() === "POST" && res.ok(),
  );
  const getQuote = page.getByRole("button", { name: "Get server quote" });
  await getQuote.scrollIntoViewIfNeeded();
  await getQuote.click();
  await quoted;
  const postedDeal = page.waitForResponse((res) => {
    const pathname = new URL(res.url()).pathname;
    return /\/api\/quotes\/[^/]+\/post$/.test(pathname) && res.request().method() === "POST";
  });
  const postQuote = page.getByRole("button", { name: "Post frozen quote" });
  await postQuote.scrollIntoViewIfNeeded();
  await postQuote.click();
  const dealRes = await postedDeal;
  const dealText = await dealRes.text();
  expect(dealRes.ok(), dealText).toBe(true);
  const deal = JSON.parse(dealText) as {
    inputAmount: string;
    feeCad: string;
    receipt: { lines: string[] };
  };
  expect(deal.inputAmount).toBe("1000.00");
  expect(deal.feeCad).toBe("2.50");
  const postedLines = flat(deal.receipt.lines.join("\n"));
  expect(postedLines).toContain(FEE);
  expect(postedLines).toContain(PAY);
  expect(postedLines).not.toMatch(/Includes\b.{0,80}fee/i);
  expect((await cadBalance(page) - before).toFixed(2)).toBe("1002.50");

  const receiptGot = page.waitForResponse((res) =>
    res.url().includes("/api/ledger/transactions/") && res.url().endsWith("/receipt") && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Receipt$/ }).click();
  const receiptRes = await receiptGot;
  const receiptText = await receiptRes.text();
  expect(receiptRes.ok(), receiptText).toBe(true);
  const receipt = JSON.parse(receiptText) as { lines: string[] };
  const gotLines = flat(receipt.lines.join("\n"));
  expect(gotLines).toContain(FEE);
  expect(gotLines).toContain(PAY);
  const rcpt = page.locator("#rcpt");
  await expect(rcpt).toBeVisible();
  const shown = flat(await rcpt.innerText());
  expect(shown).toContain(FEE);
  expect(shown).toContain(PAY);
  expect(shown).not.toMatch(/Includes\b.{0,80}fee/i);
});
