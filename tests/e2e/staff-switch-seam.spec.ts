/* The avatar menu used to rename the screen. This walks that menu,
   proves the PIN, and asks the ledger who posted the deal. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/staff-switch";
const WIDTHS = [360, 390, 1280] as const;

async function visibleAccount(page: Page) {
  const button = page.locator(".mb-acct:visible");
  await expect(button).toBeVisible();
  return button;
}

async function openSwitchList(page: Page) {
  await (await visibleAccount(page)).click();
  const menu = page.locator(".acct-menu:visible");
  await expect(menu.getByText("Switch account", { exact: true })).toBeVisible();
  return menu;
}

test("switching from the avatar menu posts the deal as the next person", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");

  const prepared = await page.evaluate(async () => {
    const login = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!login.ok) return { ok: false, step: "login", status: login.status };
    const till = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tillId: "till-switch" }),
    });
    const tillBody = await till.json().catch(() => ({}));
    const pin = await fetch("/api/staff/a.singh/pin", { method: "POST" });
    const pinBody = await pin.json().catch(() => ({}));
    return {
      ok: till.ok && pin.ok && !!(tillBody.workspaceId && pinBody.pin),
      status: { till: till.status, pin: pin.status },
      workspaceId: tillBody.workspaceId as string | undefined,
      pin: pinBody.pin as string | undefined,
      detail: tillBody,
    };
  });
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  const workspaceId = prepared.workspaceId!;
  const pin = prepared.pin!;

  await signInAtDesk(page, "m.costa");

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width >= 800 ? 800 : 780 });
    const menu = await openSwitchList(page);
    await page.screenshot({ path: `${SHOTS}/menu-${width}.png` });
    await menu.getByRole("button", { name: /A\. Singh/ }).click();
    await expect(page.getByText("Switch account", { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/pin-${width}.png` });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Switch account", { exact: true })).toBeHidden();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  const menu = await openSwitchList(page);
  await menu.getByRole("button", { name: /A\. Singh/ }).click();
  await expect(page.getByText("Switch account", { exact: true })).toBeVisible();
  for (const digit of pin) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
  await expect.poll(async () => page.evaluate(async () => {
    const me = await fetch("/api/auth/me");
    if (!me.ok) return null;
    return (await me.json()).user?.id ?? null;
  })).toBe("a.singh");
  await expect(page.locator("#menubar .mb-acct-id b")).toHaveText("A. Singh");
  await page.screenshot({ path: `${SHOTS}/desk-1280.png` });

  for (const width of [360, 390] as const) {
    await page.setViewportSize({ width, height: 780 });
    await expect(page.locator(".phone-head .mb-acct-av:visible")).toHaveText("AS");
    await page.screenshot({ path: `${SHOTS}/desk-${width}.png` });
  }

  const booked = await page.evaluate(async (ws) => {
    const headers = { "content-type": "application/json", "x-workspace-id": ws };
    const opening = await fetch("/api/ledger/opening-balances", {
      method: "POST", headers, body: JSON.stringify({ balances: { CAD: "25000.00", USD: "8000.00" } }),
    });
    const session = await fetch("/api/ledger/till-sessions/open", { method: "POST", headers });
    const sessionBody = await session.json().catch(() => ({}));
    const customer = await fetch("/api/ledger/customers", {
      method: "POST", headers,
      body: JSON.stringify({ name: "Switch customer", risk: "normal", idStatus: "verified" }),
    });
    const customerBody = await customer.json().catch(() => ({}));
    const quote = await fetch("/api/quotes", {
      method: "POST", headers,
      body: JSON.stringify({
        customerId: customerBody.customerId, from: "CAD", to: "USD",
        inputAmount: "200.00", feeCad: "4.00", direction: "customer_buy_foreign",
      }),
    });
    const quoteBody = await quote.json().catch(() => ({}));
    const posted = await fetch(`/api/quotes/${quoteBody.quoteId}/post`, {
      method: "POST", headers,
      body: JSON.stringify({
        idempotencyKey: "seam-staff-switch", purpose: "Personal travel", sourceOfFunds: "Employment income",
      }),
    });
    const list = await fetch("/api/ledger/transactions?limit=5", { headers: { "x-workspace-id": ws } });
    const listBody = await list.json().catch(() => ({}));
    return {
      opening: opening.status,
      session: session.status,
      openedBy: sessionBody.session?.openedBy ?? null,
      customer: customer.status,
      quote: quote.status,
      posted: posted.status,
      postedBody: posted.ok ? null : await posted.text(),
      actorId: listBody.transactions?.[0]?.actorId ?? null,
    };
  }, workspaceId);

  expect(booked.opening, JSON.stringify(booked)).toBe(201);
  expect(booked.session, JSON.stringify(booked)).toBe(201);
  expect(booked.posted, JSON.stringify(booked)).toBe(201);
  expect(booked.openedBy).toBe("tnt-yorkfx:a.singh");
  expect(booked.actorId).toBe("tnt-yorkfx:a.singh");
});
