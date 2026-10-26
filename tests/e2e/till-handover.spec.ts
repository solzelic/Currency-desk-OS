/* A second teller takes a till the first one still holds.
   The deal form offers Take over this till. The sheet asks for a count
   and does not show the book. Saving the count is the handover. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL");

const SHOTS = "/opt/cursor/artifacts/screenshots/till-handover";
const WIDTHS = [360, 390, 430, 600, 1280] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function heldBySingh(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me").then((r) => r.json());
    const id = String(me.user?.id ?? "");
    let balances: Record<string, string> = (await fetch("/api/ledger/till-balances").then((r) => r.json())).balances ?? {};
    if (!Object.keys(balances).length) {
      const seeded = await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" } }),
      });
      if (!seeded.ok) return await seeded.text();
      balances = (await fetch("/api/ledger/till-balances").then((r) => r.json())).balances ?? {};
    }
    const session = await fetch("/api/ledger/till-session").then((r) => r.json());
    const opener = String(session.session?.openedBy ?? "");
    const tail = id.split(":").pop();
    const mine = session.session?.status === "open" && (opener === id || opener.endsWith(":" + tail));
    if (mine) return "held";
    if (session.session?.status === "open") {
      const counts: Record<string, string> = {};
      for (const [c, v] of Object.entries(balances)) counts[c] = Number(v).toFixed(2);
      const handed = await fetch("/api/ledger/till-sessions/handover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: "seed-singh-" + Date.now(), counts }),
      });
      return handed.ok ? "held" : await handed.text();
    }
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return opened.ok || opened.status === 409 ? "held" : await opened.text();
  });
  expect(result, "singh holds the till").toBe("held");
}

async function shoot(page: Page, name: string, focus?: ReturnType<Page["locator"]>): Promise<void> {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    if (focus) await focus.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`) });
  }
}

test("a second teller takes over a held till from the deal form", async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await heldBySingh(page);

  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  /* A teller's dock has no Cash drawer. The deal form opens it the same
     way, through openApp, which does not consult that dock. */
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("till"));
  await expect(page.locator(".till-sessionline")).toContainText("opened by a.singh", { timeout: 30_000 });
  await page.locator(".till-pick button").first().click();
  const menu = page.locator(".till-pick");
  await expect(menu.getByText("a.singh on now")).toBeVisible();
  await expect(menu).not.toContainText("· you");
  await expect(menu).not.toContainText("· yours");
  await page.locator(".till-pick button").first().click();

  await page.locator('#appbar [data-app="ledger"]').click();
  const button = page.getByRole("button", { name: /^New transaction$/i }).first();
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await expect(page.locator(".cd-tx")).toBeVisible();
  await page.locator(".cd-tx-customer input").fill("Handover Walk");
  const money = page.locator(".cd-money input").first();
  await money.fill("100");
  await money.blur();
  await page.locator(".cd-tx-purpose").fill("Personal travel");
  await page.locator(".cd-tx-source").fill("Employment income");
  const go = page.locator(".cd-tx-go").last();
  await expect(go).toContainText(/Get server quote/, { timeout: 20_000 });
  await go.click();
  await expect(go).toContainText(/Post frozen quote/, { timeout: 20_000 });
  await go.click();
  const take = page.getByRole("button", { name: "Take over this till" });
  await expect(take).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".cd-tx").getByRole("alert")).toContainText("Count the till to take it over from");
  await shoot(page, "deal-prompt", take);

  await page.setViewportSize({ width: 1280, height: 900 });
  await take.click();
  const sheet = page.getByRole("dialog", { name: "Take over till" });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).not.toContainText(/expected/i);
  const sheetText = await sheet.innerText();
  for (const leaked of ["25000", "25,000", "12000", "12,000", "7000", "7,000", "3500", "3,500"]) {
    expect(sheetText, leaked).not.toContain(leaked);
  }
  const inputs = sheet.locator("input");
  await expect(inputs.first()).toBeVisible();
  const count = await inputs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await inputs.nth(i).fill("100.00");
  await shoot(page, "takeover-sheet");

  await page.setViewportSize({ width: 1280, height: 900 });
  await sheet.getByRole("button", { name: "Take over till" }).click();
  await expect(page.locator(".till-sessionline")).toContainText("opened by m.costa", { timeout: 30_000 });
  const openedBy = await page.evaluate(async () => {
    const body = await fetch("/api/ledger/till-session").then((r) => r.json());
    return String(body.session?.openedBy ?? "");
  });
  expect(openedBy.endsWith("m.costa")).toBe(true);
  await shoot(page, "after-takeover", page.locator(".till-sessionline"));
});
