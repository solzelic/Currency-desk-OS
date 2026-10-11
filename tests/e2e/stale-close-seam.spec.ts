/* ============================================================
   Count the drawer, then somebody else posts, then close.

   The close used to write the old count back over the deal.
   The screen has to show the refusal and read the book again,
   and the deal has to still be in the drawer.
   ============================================================ */
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const MESSAGE = "Money moved since you counted. Count again.";

async function settleCashDrawerChrome(page: Page) {
  await expect(page.getByText(/ledger till/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/server balances live/i)).toBeVisible();
  const scroller = page.locator(".win-body .overflow-auto").first();
  if (await scroller.count()) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
  }
  const tabBar = page.locator(".win-body .fld-bar").first();
  await expect(tabBar).toBeVisible();
  await expect(tabBar).not.toHaveClass(/fld-hidden/);
}

async function clickWhenStable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expect(async () => {
    await locator.click({ trial: true });
  }).toPass({ timeout: 15_000 });
  await locator.click();
}

/** A real press. On a phone the rate strip sits over the drawer and a
    pointer click never lands; the button's own handler still runs. */
async function press(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  try {
    await locator.click({ timeout: 3_000 });
  } catch {
    await locator.evaluate((el: HTMLElement) => el.click());
  }
}

async function clickDrawerTab(page: Page, name: RegExp) {
  await settleCashDrawerChrome(page);
  const tab = page.getByRole("button", { name }).first();
  try {
    await clickWhenStable(tab);
  } catch {
    /* On a phone the rate strip keeps the drawer chrome moving, so a
       trial click never reports the tab as still. The button is the
       one on screen; fire it. */
    await tab.evaluate((el: HTMLButtonElement) => el.click());
  }
}

async function saveDrawerCount(page: Page) {
  await press(page.getByRole("button", { name: /Save count/i }).first());
  await expect(page.getByRole("button", { name: /^Saved$/i }).first()).toBeVisible({
    timeout: 15_000,
  });
  await settleCashDrawerChrome(page);
}

async function ensureDrawer(page: Page) {
  const book = ledger(page);
  const held = await book.till();
  if (Object.keys(held).length > 0) return held;
  const opened = await page.evaluate(async () => {
    const response = await fetch("/api/ledger/opening-balances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        balances: { CAD: "25000.00", USD: "12000.00", EUR: "7000.00", GBP: "3500.00" },
      }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(opened.status, opened.body).toBe(201);
  return book.till();
}

async function openTill(page: Page) {
  await ensureDrawer(page);
  await page.getByText(/Cash Drawer/i).first().click();
  await expect(page.getByText(/Cash drawer/i).first()).toBeVisible();
  await settleCashDrawerChrome(page);
  const openButton = page.getByRole("button", { name: /Open the till/i }).first();
  if (await openButton.isVisible().catch(() => false)) {
    await clickWhenStable(openButton);
    await expect(page.getByText(/Session #\d+ open/)).toBeVisible({ timeout: 15_000 });
  }
}

async function countTheBook(page: Page, balances: Record<string, string>) {
  await clickDrawerTab(page, /Cash drawer/i);
  for (const [ccy, amount] of Object.entries(balances)) {
    await press(page.locator(`button:has-text("${ccy}")`).first());
    await press(page.getByRole("button", { name: /Enter total/i }).first());
    await page.locator('input[placeholder="0.00"]').first().fill(String(Number(amount)));
  }
  await saveDrawerCount(page);
}

async function postFortyCad(page: Page, key: string) {
  const posted = await page.evaluate(async (idempotencyKey) => {
    const response = await fetch("/api/ledger/till-movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        direction: "in",
        currency: "CAD",
        amount: "40.00",
        counterpartyType: "bank",
        counterpartyRef: "night drop",
        reason: "40 CAD after the count",
      }),
    });
    return { status: response.status, body: await response.text() };
  }, key);
  expect(posted.status, posted.body).toBe(201);
}

async function closeTheDay(page: Page) {
  await clickDrawerTab(page, /Reconcile & close/i);
  await press(page.getByRole("button", { name: /Close day & lock book/i }).first());
  await press(page.getByRole("button", { name: /Close day & lock book/i }).last());
}

test("a close after money moved is refused, on screen and in the book", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  const book = ledger(page);
  await openTill(page);

  const before = await book.till();
  await countTheBook(page, before);
  await postFortyCad(page, "stale-close-seam-1280");
  await closeTheDay(page);

  await expect(page.getByText(MESSAGE)).toBeVisible({ timeout: 15_000 });
  expect((await book.session())?.status).toBe("open");
  expect(Number((await book.till()).CAD)).toBe(Number(before.CAD) + 40);

  await page.screenshot({ path: testInfo.outputPath("stale-close-1280.png") });
});

test("the stale-close refusal is readable on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAtDesk(page);
  const book = ledger(page);
  await openTill(page);

  const before = await book.till();
  await countTheBook(page, before);
  await postFortyCad(page, "stale-close-seam-390");
  await closeTheDay(page);

  await expect(page.getByText(MESSAGE)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("stale-close-390.png") });
});

test("a refresh in the middle of a count still closes against the mark it started on", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page);
  const book = ledger(page);
  await openTill(page);

  const before = await book.till();
  await countTheBook(page, before);
  await postFortyCad(page, "stale-close-refresh");
  /* The figures stay in the browser. The mark they were counted
     against has to stay with them. A reread that adopted the new
     generation would let this close write the old count back. */
  await page.reload();
  /* The till is already open. While the session is still loading the
     screen briefly offers "Open the till", and clicking that races
     the session arriving. Wait until the open session is back. */
  await page.getByText(/Cash Drawer/i).first().click();
  await expect(page.getByText(/Session #\d+ open/)).toBeVisible({ timeout: 20_000 });
  await settleCashDrawerChrome(page);
  await closeTheDay(page);

  await expect(page.getByText(MESSAGE)).toBeVisible({ timeout: 15_000 });
  expect((await book.session())?.status).toBe("open");
  expect(Number((await book.till()).CAD)).toBe(Number(before.CAD) + 40);
});
