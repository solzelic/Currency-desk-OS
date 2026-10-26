/* A second teller takes a till the first one still holds.
   The deal form offers Take over this till. The sheet asks for a count
   and does not show the book. Saving the count is the handover. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL");

const SHOTS = "/opt/cursor/artifacts/screenshots/till-handover/round2";
const WIDTHS = [360, 390, 430, 600, 1280] as const;
const DARK = [390, 1280] as const;

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function ensureApproverPin(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/auth/login", {
    data: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  const verify = await request.post("/api/staff/pin/verify", { data: { pin: "2468" } });
  if (verify.ok()) return;
  const set = await request.post("/api/staff/pin", { data: { pin: "2468" } });
  expect(set.ok(), await set.text()).toBeTruthy();
}

async function heldBySingh(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me").then((r) => r.json());
    const id = String(me.user?.id ?? "");
    const book = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const session = await fetch("/api/ledger/till-session").then((r) => r.json());
    const opener = String(session.session?.openedBy ?? "");
    const tail = id.split(":").pop();
    const mine = session.session?.status === "open" && (opener === id || opener.endsWith(":" + tail));
    if (mine) return "held";
    if (book.amountsWithheld || (session.session?.status === "open" && !mine)) {
      const codes: string[] = Array.isArray(session.currencies) && session.currencies.length
        ? session.currencies
        : Object.keys((book.balances ?? {}) as Record<string, string>);
      const counts: Record<string, string> = {};
      for (const code of codes) counts[code] = "0.00";
      const handed = await fetch("/api/ledger/till-sessions/handover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "seed-singh-" + Date.now(),
          counts,
          approverStaffId: "j.masri",
          approverPin: "2468",
        }),
      });
      return handed.ok ? "held" : await handed.text();
    }
    const balances = (book.balances ?? {}) as Record<string, string>;
    if (!Object.keys(balances).length) {
      const seeded = await fetch("/api/ledger/opening-balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ balances: { CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" } }),
      });
      if (!seeded.ok && seeded.status !== 409) return await seeded.text();
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
  await page.evaluate(() => {
    const theme = (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme;
    theme.set("light");
  });
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    if (focus) await focus.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`) });
  }
  await page.evaluate(() => {
    (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("dark");
  });
  for (const width of DARK) {
    await page.setViewportSize({ width, height: 900 });
    if (focus) await focus.scrollIntoViewIfNeeded().catch(() => undefined);
    await page.screenshot({ path: path.join(SHOTS, `${name}-dark-${width}.png`) });
  }
  await page.evaluate(() => {
    (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("light");
  });
}

test("a second teller takes over a held till from the deal form", async ({ page, request }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  await ensureApproverPin(request);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAtDesk(page, "a.singh");
  await dismissTour(page);
  await heldBySingh(page);

  await signInAtDesk(page, "m.costa");
  await dismissTour(page);
  const balanceHits: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/ledger/till-balances")) balanceHits.push(req.url());
  });
  /* A teller's dock has no Cash drawer. The deal form opens it the same
     way, through openApp, which does not consult that dock. */
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("till"));
  await expect(page.locator(".till-sessionline")).toContainText(/opened by A\.\s*Singh/, { timeout: 30_000 });
  await expect(page.locator(".till-sessionline")).not.toContainText("a.singh");
  await page.locator(".till-pick button").first().click();
  const menu = page.locator(".till-pick");
  await expect(menu.getByText(/A\.\s*Singh on now/)).toBeVisible();
  await expect(menu).not.toContainText("a.singh");
  await expect(menu).not.toContainText("· you");
  await expect(menu).not.toContainText("· yours");
  await page.locator(".till-pick button").first().click();
  const strip = page.locator('[data-takeover="strip"]');
  await expect(strip).toBeVisible();
  const stripBox = await strip.boundingBox();
  expect(stripBox && stripBox.height).toBeGreaterThanOrEqual(44);

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
  await expect(page.locator(".cd-tx").getByRole("button", { name: "Post frozen quote" })).toHaveCount(0);
  await expect(page.locator(".cd-tx").getByRole("alert")).toContainText(/A\.\s*Singh holds this till/);
  await expect(page.locator(".cd-tx")).not.toContainText("a.singh");
  await shoot(page, "deal-prompt", take);

  await page.setViewportSize({ width: 1280, height: 900 });
  await take.click();
  const sheet = page.getByRole("dialog", { name: "Take over till" });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toContainText(/Held by A\.\s*Singh/);
  await expect(sheet).toContainText("Expected amounts stay hidden.");
  await expect(sheet).not.toContainText("a.singh");
  expect(balanceHits, "till balances while someone else holds it").toEqual([]);
  for (const code of ["CAD", "USD", "EUR", "GBP"]) {
    const field = sheet.getByLabel(`${code} counted`);
    if (await field.count()) await expect(field).toHaveAttribute("placeholder", "0.00");
  }
  const yen = sheet.getByLabel("JPY counted");
  if (await yen.count()) await expect(yen).toHaveAttribute("placeholder", "0");
  const fieldBox = await sheet.locator("input").first().boundingBox();
  expect(fieldBox && fieldBox.height).toBeGreaterThanOrEqual(44);
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
  await expect(sheet).toContainText("The count does not match. A supervisor must approve this takeover.", { timeout: 20_000 });
  await expect(sheet.getByLabel("Supervisor staff id")).toBeVisible();
  await expect(sheet.getByLabel("Supervisor PIN")).toBeVisible();
  const gated = await sheet.innerText();
  expect(gated).not.toMatch(/25000|25,000|12000|12,000|7000|3500/);
  expect(gated).not.toMatch(/\p{Regional_Indicator}/u);
  await expect(sheet.locator("img")).toHaveCount(0);
  await shoot(page, "approver-pin", sheet);
  await sheet.getByLabel("Supervisor staff id").fill("j.masri");
  await sheet.getByLabel("Supervisor PIN").fill("2468");
  await page.setViewportSize({ width: 1280, height: 900 });
  await sheet.getByRole("button", { name: "Take over till" }).click();
  await expect(page.locator(".till-sessionline")).toContainText(/opened by M\.\s*Costa/, { timeout: 30_000 });
  await expect(page.locator("[data-count-result]")).toHaveCount(0);
  await expect(page.locator(".till-taken, .till-sessionline")).not.toContainText("25000");
  const openedBy = await page.evaluate(async () => {
    const body = await fetch("/api/ledger/till-session").then((r) => r.json());
    return String(body.session?.openedBy ?? "");
  });
  expect(openedBy.endsWith("m.costa")).toBe(true);
  await shoot(page, "after-takeover", page.locator(".till-sessionline"));
});

test("the old holder's till names who took it over", async ({ browser, request }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  await ensureApproverPin(request);
  const singhContext = await browser.newContext();
  const costaContext = await browser.newContext();
  const singh = await singhContext.newPage();
  const costa = await costaContext.newPage();
  await singh.setViewportSize({ width: 1280, height: 900 });
  await signInAtDesk(singh, "a.singh");
  await dismissTour(singh);
  await heldBySingh(singh);
  await singh.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("till"));
  await expect(singh.locator(".till-sessionline")).toContainText(/opened by A\.\s*Singh/, { timeout: 30_000 });
  await signInAtDesk(costa, "m.costa");
  await dismissTour(costa);
  const handed = await costa.evaluate(async () => {
    const book = await fetch("/api/ledger/till-balances").then((r) => r.json());
    if (book.amountsWithheld || !book.balances || !Object.keys(book.balances).length) {
      return "withheld";
    }
    const counts: Record<string, string> = {};
    for (const [c, v] of Object.entries(book.balances as Record<string, string>)) counts[c] = Number(v).toFixed(2);
    const res = await fetch("/api/ledger/till-sessions/handover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "old-tab-" + Date.now(), counts }),
    });
    return res.ok ? "ok" : await res.text();
  });
  /* Costa does not hold the till, so the book is withheld. Singh still
     holds it on the other tab and can read the amounts for the count. */
  expect(handed).toBe("withheld");
  const counts = await singh.evaluate(async () => {
    const book = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const counts: Record<string, string> = {};
    for (const [c, v] of Object.entries((book.balances ?? {}) as Record<string, string>)) counts[c] = Number(v).toFixed(2);
    return counts;
  });
  const posted = await costa.evaluate(async (body) => {
    const res = await fetch("/api/ledger/till-sessions/handover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "old-tab-" + Date.now(), counts: body }),
    });
    return res.ok ? "ok" : await res.text();
  }, counts);
  expect(posted, "costa takes the till").toBe("ok");
  await singh.evaluate(() => window.dispatchEvent(new Event("focus")));
  const notice = singh.locator(".till-taken");
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(notice).toContainText(/till-01 was taken over by M\.\s*Costa at \d{1,2}:\d{2} [ap]m\./);
  await expect(notice).not.toContainText("a.singh");
  await expect(notice).not.toContainText("m.costa");
  await expect(notice.getByRole("button", { name: "Go to counter" })).toBeVisible();
  await expect(singh.locator('[data-takeover="chip"]')).toHaveCount(0);
  await expect(singh.locator('[data-takeover="strip"]')).toHaveCount(0);
  await shoot(singh, "old-holder", notice);
  await singhContext.close();
  await costaContext.close();
});
