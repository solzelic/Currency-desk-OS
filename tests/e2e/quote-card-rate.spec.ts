/* The quote card priced the payout from the server and the rate from
   the browser. 3,000 CAD previews 0.72225. The server freezes
   0.722104, and 2,166.31 is the payout that rate produces. */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireRoot = createRequire(path.join(process.cwd(), "package.json"));
const { effectiveRate } = requireRoot("./os-src/effective-rate.js") as {
  effectiveRate: (amount: string, payout: string, places: number) => { text: string; rounded: boolean };
};
const Decimal = requireRoot("./server/node_modules/decimal.js") as new (v: string) => {
  toDecimalPlaces: (n: number) => { toFixed: (n: number) => string };
};

const SHOTS = "/opt/cursor/artifacts/quote-card";

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function openDeal(page: Page) {
  await signInAtDesk(page, "m.costa");
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

test("the quote card renders the server rate", async ({ page }, testInfo) => {
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
  await openDeal(page);
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
  const priced = effectiveRate(body.inputAmount, body.outputAmount, 2);
  const line = `1 ${body.from} = ${priced.text} ${body.to}`;
  await expect(ticket).toContainText(line);
  await expect(ticket).not.toContainText("0.72225");
  await expect(page.locator(".cd-tx-rate-line .cd-tx-kicker")).toHaveText(line);
  if (priced.rounded) await expect(ticket).toContainText("Rate rounded. The amounts are exact.");

  mkdirSync(SHOTS, { recursive: true });
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    await ticket.scrollIntoViewIfNeeded();
    const shot = `${SHOTS}/quote_card_${width}.png`;
    await page.screenshot({ path: shot });
    await testInfo.attach(`quote-card-${width}`, { path: shot, contentType: "image/png" });
  }
});
