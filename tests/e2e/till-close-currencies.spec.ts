/* ============================================================
   Open a till, sell yen, count it, close the day.

   The count sheet's chips used to be a fixed bill table. Yen is not
   in that table, so a drawer that held yen could not be counted and
   the close was never sent. This drives the sheet: the yen chip is
   there, the field is a whole number, and the ledger afterwards is
   the count that was typed.
   ============================================================ */
import { mkdirSync } from "node:fs";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const TILL = "till-jpy-close";
const SHOTS = "/opt/cursor/artifacts/screenshots";

async function settleCashDrawerChrome(page: Page) {
  await expect(page.getByText(/ledger till/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/server balances live/i)).toBeVisible();
  const scroller = page.locator(".win.show.active .win-body .overflow-auto").first();
  if (await scroller.count()) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  const tabBar = page.locator(".win.show.active .win-body .fld-bar").first();
  await expect(tabBar).toBeVisible();
  await expect(tabBar).not.toHaveClass(/fld-hidden/);
}

async function press(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  try {
    await locator.click({ timeout: 3_000 });
  } catch {
    await locator.evaluate((el: HTMLElement) => el.click());
  }
}

async function openDrawer(page: Page) {
  const phoneTab = page.locator('#phonebar [data-phone-app="till"]');
  const title = page.locator(".win.show.active .win-title", { hasText: /Cash drawer/i });
  if (await phoneTab.isVisible()) {
    await phoneTab.click();
    await expect(phoneTab).toHaveClass(/is-on/);
  } else {
    const tab = page.locator('#appbar [data-app="till"]');
    await tab.scrollIntoViewIfNeeded();
    await tab.click();
    await expect(title).toBeVisible();
  }
  await settleCashDrawerChrome(page);
}

async function api(page: Page, workspaceId: string, method: string, url: string, body?: unknown) {
  return page.evaluate(
    async ({ method, url, body, workspaceId }) => {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-workspace-id": workspaceId,
        },
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep the text */
      }
      return { status: response.status, body: parsed };
    },
    { method, url, body, workspaceId },
  );
}

test("a till that sold yen can be counted and closed from the sheet", async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "r.haddad");

  const created = await page.evaluate(async (tillId) => {
    const response = await fetch("/api/desk/branches/br-yorkville/tills", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tillId }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, TILL);
  const workspaceId = (created.body.till?.workspaceId ?? created.body.workspaceId) as string;
  expect(workspaceId, JSON.stringify(created)).toBeTruthy();

  const selected = await api(page, workspaceId, "POST", "/api/ledger/till-selection", {});
  expect(selected.status, JSON.stringify(selected.body)).toBe(200);
  await page.evaluate((ws) => {
    localStorage.setItem("cdesk.ledger.till.r.haddad", ws);
  }, workspaceId);
  await page.reload();
  await landOnDesktop(page);
  await openDrawer(page);

  /* A fresh till asks to be opened. A rerun on the same database finds
     the day already closed, and the way back in is the next session —
     the same button a teller uses the morning after. */
  const openButton = page.getByRole("button", { name: /Open the till/i }).first();
  const nextDay = page.getByRole("button", { name: /Open next day/i }).first();
  const sessionLine = page.getByText(/Session #\d+ open/);
  await expect(async () => {
    if (await sessionLine.isVisible()) return;
    if (await nextDay.isVisible()) await nextDay.click({ timeout: 1_000 });
    else {
      const reconcile = page.getByRole("button", { name: /Reconcile & close/i }).first();
      if (!(await openButton.isVisible()) && (await reconcile.isVisible())) {
        await reconcile.click({ timeout: 1_000 });
      }
      if (await nextDay.isVisible()) await nextDay.click({ timeout: 1_000 });
      else await openButton.click({ timeout: 1_000 });
    }
    await expect(sessionLine).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  const floatedCad = await api(page, workspaceId, "POST", "/api/ledger/till-movements", {
    idempotencyKey: `jpy-close-cad-${Date.now()}`,
    direction: "in",
    currency: "CAD",
    amount: "5000.00",
    counterpartyType: "bank",
    counterpartyRef: "morning",
    reason: "CAD to sell yen against",
  });
  expect(floatedCad.status, JSON.stringify(floatedCad.body)).toBe(201);
  const floatedJpy = await api(page, workspaceId, "POST", "/api/ledger/till-movements", {
    idempotencyKey: `jpy-close-jpy-${Date.now()}`,
    direction: "in",
    currency: "JPY",
    amount: "200000.00",
    counterpartyType: "bank",
    counterpartyRef: "morning",
    reason: "Yen for the counter",
  });
  expect(floatedJpy.status, JSON.stringify(floatedJpy.body)).toBe(201);

  const customer = await api(page, workspaceId, "POST", "/api/ledger/customers", {
    externalRef: `jpy-close-${Date.now()}`,
    name: "Yen Close",
    risk: "normal",
    idStatus: "verified",
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const customerId = (customer.body as { customerId: string }).customerId;

  const quote = await api(page, workspaceId, "POST", "/api/quotes", {
    customerId,
    from: "CAD",
    to: "JPY",
    inputAmount: "100.00",
    feeCad: "0.00",
    direction: "customer_buy_foreign",
  });
  expect(quote.status, JSON.stringify(quote.body)).toBe(201);
  const quoteId = (quote.body as { quoteId: string }).quoteId;
  const posted = await api(page, workspaceId, "POST", `/api/quotes/${quoteId}/post`, {
    idempotencyKey: `jpy-close-sale-${Date.now()}`,
    purpose: "Travel",
    sourceOfFunds: "Employment income",
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);

  await page.reload();
  await landOnDesktop(page);
  await openDrawer(page);
  await expect(page.getByRole("button", { name: TILL, exact: true })).toBeVisible();

  const held = await api(page, workspaceId, "GET", "/api/ledger/till-balances");
  const balances = (held.body as { balances: Record<string, string> }).balances;
  expect(Number(balances.JPY)).toBeGreaterThan(0);
  expect(balances.JPY).not.toBe("200000.00");
  const wholeYen = String(Math.trunc(Number(balances.JPY)));

  await press(page.locator('button.till-chip', { hasText: "JPY" }).first());
  await expect(page.getByText("Enter total", { exact: true })).toBeVisible();
  await expect(page.getByText(/no minor unit/i)).toBeVisible();
  const yenField = page.locator('input[placeholder="0"]').first();
  await expect(yenField).toBeVisible();
  const drawer = page.locator(".win.show.active").first();
  await drawer.screenshot({ path: `${SHOTS}/till-close-jpy-1280.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await drawer.screenshot({ path: `${SHOTS}/till-close-jpy-390.png` });

  await page.setViewportSize({ width: 1280, height: 800 });
  await press(page.locator('button.till-chip', { hasText: "CAD" }).first());
  await expect(page.getByRole("button", { name: "Count denominations" })).toBeVisible();
  await drawer.screenshot({ path: `${SHOTS}/till-close-cad-1280.png` });

  await press(page.getByRole("button", { name: "Enter total" }).first());
  await page.locator('input[placeholder="0.00"]').first().fill(String(Number(balances.CAD)));
  await press(page.locator('button.till-chip', { hasText: "JPY" }).first());
  await yenField.fill(wholeYen);

  await press(page.getByRole("button", { name: /Reconcile & close/i }).first());
  const closeDay = page.getByRole("button", { name: /Close day & lock book/i }).first();
  await expect(closeDay).toBeEnabled({ timeout: 15_000 });
  await press(closeDay);
  await press(page.getByRole("button", { name: /Close day & lock book/i }).last());

  await expect(page.getByText(/closed — nicely done/i)).toBeVisible({ timeout: 20_000 });
  const after = await api(page, workspaceId, "GET", "/api/ledger/till-balances");
  const closedBook = (after.body as { balances: Record<string, string> }).balances;
  expect(closedBook.JPY).toBe(`${wholeYen}.00`);
  expect(Number(closedBook.CAD)).toBe(Number(balances.CAD));
  const session = await api(page, workspaceId, "GET", "/api/ledger/till-session");
  expect((session.body as { session: { status: string } }).session.status).toBe("closed");
});
