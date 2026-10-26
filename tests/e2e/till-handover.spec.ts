/* A second teller takes a till the first one still holds.
   The till offers Take over till. The sheet asks for a count
   and does not show the book. Saving the count is the handover. */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL");

const SHOTS = "/opt/cursor/artifacts/screenshots/till-handover/gate";
const WIDTHS = [360, 390, 430, 600, 1280] as const;
const DARK = [390, 1280] as const;
const MISMATCH = "The count does not match. A supervisor must approve this takeover.";

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
    (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set("light");
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
  /* A teller's dock has no Cash drawer. openApp opens it anyway. */
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("till"));
  await expect(page.locator(".till-sessionline")).toContainText("opened by a.singh", { timeout: 30_000 });
  await expect(page.locator(".till-grand")).toHaveCount(0);
  await expect(page.locator(".till-counted input").first()).toHaveValue("");
  const screen = await page.locator(".till-count-sheet").innerText();
  for (const leaked of ["25000", "25,000", "12000", "12,000", "7000", "7,000", "3500", "3,500", "64870", "146,510"]) {
    expect(screen, leaked).not.toContain(leaked);
  }
  const take = page.locator('[data-takeover="strip"]');
  await expect(take).toBeVisible({ timeout: 20_000 });
  await page.setViewportSize({ width: 1280, height: 900 });
  await take.click();
  const sheet = page.getByRole("dialog", { name: "Take over till" });
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect(sheet).toContainText("Expected amounts stay hidden until you save this count.");
  await expect(sheet).toContainText(/Held by A\.\s*Singh/);
  await expect(sheet).not.toContainText("a.singh");
  const before = await sheet.innerText();
  for (const leaked of ["25000", "25,000", "12000", "12,000", "7000", "7,000", "3500", "3,500"]) {
    expect(before, leaked).not.toContain(leaked);
  }
  expect(before).not.toMatch(/\p{Regional_Indicator}/u);
  expect(await sheet.locator("img").count()).toBe(0);
  const inputs = sheet.locator("input");
  await expect(inputs.first()).toBeVisible();
  const count = await inputs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await inputs.nth(i).fill("100.00");

  await page.setViewportSize({ width: 1280, height: 900 });
  await sheet.getByRole("button", { name: "Take over till" }).click();
  const alert = sheet.getByRole("alert");
  await expect(alert).toHaveText(MISMATCH, { timeout: 30_000 });
  const openedBy = await page.evaluate(async () => {
    const body = await fetch("/api/ledger/till-session").then((r) => r.json());
    return String(body.session?.openedBy ?? "");
  });
  expect(openedBy.endsWith("a.singh")).toBe(true);
  await expect(page.locator(".till-sessionline")).toContainText("opened by a.singh");
  await shoot(page, "takeover-403", alert);
});
