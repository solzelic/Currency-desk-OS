/* The quote card priced the payout from the server and the rate from
   the browser. 3,000 CAD previews 0.72225. The server freezes
   0.722104, and 2,166.31 is the payout that rate produces. */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireRoot = createRequire(path.join(process.cwd(), "package.json"));
const Decimal = requireRoot("./server/node_modules/decimal.js") as new (v: string) => {
  toDecimalPlaces: (n: number) => { toFixed: (n: number) => string };
};

const SHOTS = "/opt/cursor/artifacts/quote-card";
const REPO_SHOTS = path.join(process.cwd(), "docs/pr-shots/quote-card");

/* Post as the person who already holds the till. Taking it over
   leaves the next file unable to post. A short drawer is topped up
   by that same person when they are allowed to move cash. */
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
        idempotencyKey: `quote-card-usd-${Date.now()}`,
        direction: "in",
        currency: "USD",
        amount: (5000 - have).toFixed(2),
        counterpartyType: "bank",
        counterpartyRef: "quote-card",
        reason: "Float so the quote card can pay the dollars",
      },
    });
    expect(answer.ok(), await answer.text()).toBe(true);
  };
  /* A pay-in updates a currency row. A drawer that has never held CAD
     has no row, and the post is refused even though the cash is coming in. */
  const ensureCad = async () => {
    const res = await request.get("/api/ledger/till-balances");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { balances?: Record<string, string> };
    if (body.balances && Object.prototype.hasOwnProperty.call(body.balances, "CAD")) return;
    const answer = await request.post("/api/ledger/till-movements", {
      data: {
        idempotencyKey: `quote-card-cad-${Date.now()}`,
        direction: "in",
        currency: "CAD",
        amount: "1.00",
        counterpartyType: "bank",
        counterpartyRef: "quote-card",
        reason: "Home cash so a CAD pay-in has a drawer row",
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
      await ensureCad();
      return "a.singh";
    }
    return "m.costa";
  }
  await login(staffId || "a.singh");
  if (have < 2500) await topUp(have);
  await ensureCad();
  return staffId || "m.costa";
}

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
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

test("the quote card renders the server rate", async ({ page, request }, testInfo) => {
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
  await amount.fill("3000");
  await amount.blur();
  const ticket = page.locator(".cd-tx-ticket");
  await expect(ticket).toContainText("1 CAD = 0.72225 USD");

  await page.locator(".cd-tx-purpose").fill("travel");
  await page.locator(".cd-tx-source").fill("salary");
  const posted = page.waitForResponse(
    (res) => res.url().includes("/api/quotes") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Get server quote" }).click();
  const body = await (await posted).json() as {
    customerRate: string;
    inputAmount: string;
    outputAmount: string;
    from: string;
    to: string;
  };
  expect(new Decimal(body.customerRate).toDecimalPlaces(6).toFixed(6)).toBe("0.722104");
  expect(body.outputAmount).toBe("2166.31");
  await expect(ticket).toContainText("1 CAD = 0.7221 USD");
  await expect(ticket).not.toContainText("0.72225");
  await expect(ticket).not.toContainText("0.7227");
  await expect(page.locator(".cd-tx-rate-line .cd-tx-kicker")).toHaveText("1 CAD = 0.7221 USD");
  await expect(ticket).toContainText("Rate rounded. The amounts are exact.");
  await expect(ticket).not.toContainText("0.722104");

  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(REPO_SHOTS, { recursive: true });
  for (const width of [360, 390, 430, 600, 1280]) {
    await page.setViewportSize({ width, height: width >= 600 ? 800 : 844 });
    await ticket.scrollIntoViewIfNeeded();
    const name = `quote_card_${width}.png`;
    const shot = `${SHOTS}/${name}`;
    await page.screenshot({ path: shot });
    copyFileSync(shot, path.join(REPO_SHOTS, name));
    await testInfo.attach(`quote-card-${width}`, { path: shot, contentType: "image/png" });
  }

  /* 7.50 solves to 0.7227 from the payout. The card keeps the frozen 0.7221. */
  await page.setViewportSize({ width: 1280, height: 800 });
  await amount.fill("7.50");
  await amount.blur();
  const smallPosted = page.waitForResponse(
    (res) => res.url().includes("/api/quotes") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Get server quote" }).click();
  const small = await (await smallPosted).json() as { customerRate: string; outputAmount: string; to: string };
  expect(small.outputAmount).toBe("5.42");
  expect(small.to).toBe("USD");
  expect(new Decimal(small.customerRate).toDecimalPlaces(6).toFixed(6)).toBe("0.722104");
  await expect(page.locator(".cd-tx-rate-line .cd-tx-kicker")).toHaveText("1 CAD = 0.7221 USD");
  await expect(ticket).not.toContainText("0.7227");
  await expect(ticket).toContainText("Rate rounded. The amounts are exact.");

  /* Euro is a different frozen rate. 7.50 solves to 0.6693. The card keeps 0.6696. */
  await page.locator(".cd-money", { has: page.locator(".cd-tx-receive") }).getByRole("button").click();
  await page.getByRole("button", { name: /Euro/ }).click();
  await amount.fill("7.50");
  await amount.blur();
  const eurPosted = page.waitForResponse(
    (res) => res.url().includes("/api/quotes") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Get server quote" }).click();
  const eur = await (await eurPosted).json() as { customerRate: string; outputAmount: string; to: string };
  expect(eur.outputAmount).toBe("5.02");
  expect(eur.to).toBe("EUR");
  expect(new Decimal(eur.customerRate).toDecimalPlaces(6).toFixed(6)).toBe("0.669603");
  await expect(page.locator(".cd-tx-rate-line .cd-tx-kicker")).toHaveText("1 CAD = 0.6696 EUR");
  await expect(ticket).not.toContainText("0.6693");
  await expect(ticket).toContainText("Rate rounded. The amounts are exact.");

  await page.locator(".cd-money", { has: page.locator(".cd-tx-receive") }).getByRole("button").click();
  await page.getByRole("button", { name: /US Dollar/ }).click();
  await amount.fill("3000");
  await amount.blur();
  const again = page.waitForResponse(
    (res) => res.url().includes("/api/quotes") && res.request().method() === "POST" && res.ok(),
  );
  await page.getByRole("button", { name: "Get server quote" }).click();
  const restored = await (await again).json() as { outputAmount: string };
  expect(restored.outputAmount).toBe("2166.31");
  await expect(page.locator(".cd-tx-rate-line .cd-tx-kicker")).toHaveText("1 CAD = 0.7221 USD");

  /* The card stays at four places. The receipt prints the stored rate at six. */
  const postedDeal = page.waitForResponse((res) => {
    const pathname = new URL(res.url()).pathname;
    return /\/api\/quotes\/[^/]+\/post$/.test(pathname) && res.request().method() === "POST";
  });
  const postButton = page.getByRole("button", { name: "Post frozen quote" });
  await postButton.scrollIntoViewIfNeeded();
  await postButton.click();
  const dealRes = await postedDeal;
  expect(dealRes.ok(), "frozen quote posted").toBe(true);
  const deal = await dealRes.json() as { rate: string; receipt: { lines: string[] } };
  expect(new Decimal(deal.rate).toDecimalPlaces(6).toFixed(6)).toBe("0.722104");
  expect(deal.receipt.lines.join("\n")).toContain("Rate: 1 CAD = 0.722104 USD");

  const receiptGot = page.waitForResponse((res) =>
    res.url().includes("/api/ledger/transactions/") && res.url().endsWith("/receipt") && res.request().method() === "GET",
  );
  await page.getByRole("button", { name: /^Receipt$/ }).click();
  const receiptRes = await receiptGot;
  expect(receiptRes.ok(), "receipt fetched").toBe(true);
  const receipt = await receiptRes.json() as { lines: string[] };
  expect(receipt.lines.join("\n")).toContain("Rate: 1 CAD = 0.722104 USD");
  const rcpt = page.locator("#rcpt");
  await expect(rcpt).toBeVisible();
  await expect(rcpt).toContainText("1 CAD = 0.722104 USD");
  await expect(rcpt).not.toContainText("Rate rounded");
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    const rate = rcpt.getByText("1 CAD = 0.722104 USD");
    const fits = await rate.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth + 1
        && box.left >= -1
        && box.right <= window.innerWidth + 1
        && box.width > 8;
    });
    expect(fits).toBe(true);
    const name = `receipt_${width}.png`;
    const shot = `${SHOTS}/${name}`;
    await page.screenshot({ path: shot });
    copyFileSync(shot, path.join(REPO_SHOTS, name));
    await testInfo.attach(`receipt-${width}`, { path: shot, contentType: "image/png" });
  }
});
