/* The avatar menu used to rename the screen. This walks that menu,
   proves the PIN refusals stay inside the dialog, and asks the ledger
   who posted the deal. */
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { APIRequestContext, Page } from "@playwright/test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const SHOTS = "/opt/cursor/artifacts/pr163";
const STORE = "/cursor/stores/self/pr163";
const NO_PIN = "A. Singh has no PIN yet. Ask a manager to set one.";
const WEAK = "0000 is too easy to guess. Pick a different PIN.";
const LOCKED = "Too many wrong tries. Ask a manager to unlock A. Singh.";

async function visibleAccount(page: Page) {
  const button = page.locator(".mb-acct:visible");
  await expect(button).toBeVisible();
  return button;
}

async function openSwitchList(page: Page) {
  await (await visibleAccount(page)).click();
  const menu = page.locator(".acct-menu:visible");
  await expect(menu.getByText("Switch account", { exact: true })).toBeVisible();
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  return menu;
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  const path = `${SHOTS}/${name}`;
  await page.screenshot({ path });
  if (existsSync("/cursor/stores/self")) {
    mkdirSync(STORE, { recursive: true });
    copyFileSync(path, `${STORE}/${name}`);
  }
}

const NITS = "/opt/cursor/artifacts/design-nits";

async function nitShot(page: Page, name: string) {
  mkdirSync(NITS, { recursive: true });
  const path = `${NITS}/${name}`;
  await page.screenshot({ path });
  if (existsSync("/cursor/stores/self")) {
    mkdirSync("/cursor/stores/self/design-nits", { recursive: true });
    copyFileSync(path, `/cursor/stores/self/design-nits/${name}`);
  }
}

async function expectNoPinOk(page: Page) {
  await expect(page.getByText(NO_PIN)).toBeVisible();
  await expect(page.getByRole("button", { name: "OK", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1", exact: true })).toHaveCount(0);
}

async function typePin(page: Page, digits: string) {
  for (const digit of digits) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

async function openSinghPin(page: Page) {
  const menu = await openSwitchList(page);
  await menu.getByRole("button", { name: /A\. Singh/ }).click();
  await expect(page.getByText("Switch account", { exact: true })).toBeVisible();
}

async function issuePin(request: APIRequestContext): Promise<string> {
  const pin = await request.post("/api/staff/a.singh/pin");
  const body = await pin.json();
  expect(pin.ok(), JSON.stringify(body)).toBe(true);
  expect(body.pin).toMatch(/^\d{4}$/);
  return body.pin as string;
}

test("switching from the avatar menu posts the deal as the next person", async ({ page, request }) => {
  mkdirSync(SHOTS, { recursive: true });
  const login = await request.post("/api/auth/login", {
    data: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" },
  });
  expect(login.ok(), await login.text()).toBe(true);
  const till = await request.post("/api/desk/branches/br-yorkville/tills", {
    data: { tillId: "till-switch" },
  });
  const tillBody = await till.json();
  expect(till.ok(), JSON.stringify(tillBody)).toBe(true);
  const workspaceId = tillBody.workspaceId as string;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await signInAtDesk(page, "m.costa");

  const menu = await openSwitchList(page);
  await shot(page, "menu-1280.png");
  await menu.getByRole("button", { name: /A\. Singh/ }).click();
  await expect(page.getByText("Switch account", { exact: true })).toBeVisible();
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeVisible();
  const face = await cancel.evaluate((el) => ({
    family: (el as HTMLElement).style.fontFamily,
    size: (el as HTMLElement).style.fontSize,
  }));
  expect(face.size).toBe("15px");
  expect(face.family.toLowerCase()).not.toContain("space mono");
  expect(face.family).toMatch(/Archivo|f-display|system-ui/);
  await cancel.click();
  await expect(page.getByText("Switch account", { exact: true })).toBeHidden();

  await page.setViewportSize({ width: 390, height: 780 });
  await openSinghPin(page);
  await typePin(page, "1357");
  await expectNoPinOk(page);
  await shot(page, "refusal-no-pin-390.png");
  await nitShot(page, "no-pin-390.png");
  await page.getByRole("button", { name: "OK", exact: true }).click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await openSinghPin(page);
  await typePin(page, "1357");
  await expectNoPinOk(page);
  await nitShot(page, "no-pin-1280.png");
  await page.getByRole("button", { name: "OK", exact: true }).click();

  await page.setViewportSize({ width: 390, height: 780 });
  await issuePin(request);
  await openSinghPin(page);
  await typePin(page, "0000");
  await expect(page.getByText(WEAK)).toBeVisible();
  await shot(page, "refusal-0000-390.png");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await openSinghPin(page);
  for (let i = 0; i < 4; i++) {
    await typePin(page, "1111");
    await expect(page.getByText("Incorrect PIN")).toBeVisible();
    await page.waitForTimeout(350);
  }
  await typePin(page, "1111");
  await expect(page.getByText(LOCKED)).toBeVisible();
  await expect(page.getByRole("button", { name: "OK", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1", exact: true })).toHaveCount(0);
  await shot(page, "refusal-lockout-390.png");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Switch account", { exact: true })).toBeHidden();

  const nextPin = await issuePin(request);

  await page.setViewportSize({ width: 1280, height: 800 });
  await openSinghPin(page);
  await typePin(page, nextPin);
  await expect.poll(async () => page.evaluate(async () => {
    const me = await fetch("/api/auth/me");
    if (!me.ok) return null;
    return (await me.json()).user?.id ?? null;
  })).toBe("a.singh");
  await expect(page.locator("#menubar .mb-acct-id b")).toHaveText("A. Singh");
  await page.waitForTimeout(1000);
  await expect(page.locator(".cdos-tour")).toHaveCount(0);
  await expect(page.getByText(/First run/)).toHaveCount(0);
  await shot(page, "desk-1280.png");

  const booked = await page.evaluate(async (ws) => {
    const headers = { "content-type": "application/json", "x-workspace-id": ws };
    const opening = await fetch("/api/ledger/opening-balances", {
      method: "POST", headers, body: JSON.stringify({ balances: { CAD: "25000.00", USD: "8000.00" } }),
    });
    const session = await fetch("/api/ledger/till-sessions/open", { method: "POST", headers, body: "{}" });
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
