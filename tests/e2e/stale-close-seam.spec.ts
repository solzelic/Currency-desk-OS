/* ============================================================
   Count the drawer, then somebody else posts, then close.

   The close used to write the old count back over the deal.
   The screen has to show the refusal and read the book again,
   and the deal has to still be in the drawer.
   ============================================================ */
import fs from "fs";
import { test, expect, hasLedger, signInAtDesk, ledger } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { phoneSweep } from "./helpers/phone-sweep";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const MESSAGE = "Money moved since you counted. Count again.";

async function settleCashDrawerChrome(page: Page) {
  /* The phone drawer is the count inside the phone shell. It does not
     print the desktop "ledger till" line. The heading is the proof
     the drawer is the one on screen. */
  if (await page.locator(".till-phone").isVisible()) {
    await expect(page.getByRole("heading", { name: "Cash drawer" })).toBeVisible({ timeout: 30_000 });
    return;
  }
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
  if (await page.locator(".till-phone").isVisible()) {
    const phoneName = /cash drawer/i.test(name.source) ? /^Count$/ : /^Reconcile and close$/;
    await press(page.getByRole("tab", { name: phoneName }).first());
    return;
  }
  const tab = page.locator(".win.show.active").getByRole("button", { name }).first();
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
  const root = (await page.locator(".till-phone").isVisible())
    ? page.locator(".till-phone")
    : page.locator(".win.show.active");
  await press(root.getByRole("button", { name: /Save count/i }).first());
  await expect(root.getByRole("button", { name: /^Saved$/i }).first()).toBeVisible({
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
  /* The menu's active-app label is the first "Cash Drawer" in the
     document, and on a phone that label is hidden with the menu.
     Wider than 430px the dock tab is the way in, and the window
     title has to be on screen. On a phone the bottom bar replaces
     the dock and the window title bar is hidden, so the Till tab
     is what has to be selected. isVisible answers this instant. A
     hidden bar is false, not an error, so there is nothing to catch. */
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
  const sessionLine = page.getByText(/Session #\d+ open/);
  /* The drawer paints "Open the till" while the session is still
     arriving, then takes the button away once the book says the till
     is open. Wait until that line is on screen. A click that lands
     after the button has gone is retried; the line being there
     already means there is nothing to open. */
  /* A closed session offers "Open next day" on the desktop reconcile
     tab, and "Open next session" on the phone. Neither is "Open the
     till", which is only the banner before the first session. */
  await expect(async () => {
    if (await sessionLine.isVisible()) return;
    const skip = page.locator(".cdos-tour-skip");
    if (await skip.isVisible()) await skip.click();
    const next = page.getByRole("button", { name: /Open the till|Open next day|Open next session/i }).first();
    if (await next.isVisible()) await next.click({ timeout: 1_000 });
    else if (await page.locator(".till-phone").isVisible()) {
      await page.getByRole("tab", { name: "Reconcile and close" }).click({ timeout: 1_000 });
    } else {
      await page.getByRole("button", { name: /Reconcile & close/i }).first().click({ timeout: 1_000 });
    }
    await expect(sessionLine).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

async function countTheBook(page: Page, balances: Record<string, string>) {
  await clickDrawerTab(page, /Cash drawer/i);
  /* The phone ledger's summary buttons also say "CAD", and that
     window stays in the document after you leave it. The chip that
     counts is the open drawer's till chip. */
  const phone = await page.locator(".till-phone").isVisible();
  const root = phone ? page.locator(".till-phone") : page.locator(".win.show.active");
  for (const [ccy, amount] of Object.entries(balances)) {
    if (phone) {
      await press(root.getByRole("tab", { name: new RegExp("^" + ccy + "\\b") }).first());
      const enter = root.getByRole("button", { name: "Enter total instead" });
      if (await enter.isVisible()) await press(enter);
      await root.getByRole("textbox", { name: ccy + " total" }).fill(String(Number(amount)));
    } else {
      await press(root.locator(`button.till-chip:has-text("${ccy}")`).first());
      await press(root.getByRole("button", { name: /Enter total/i }).first());
      await root.locator('input[placeholder="0.00"]').first().fill(String(Number(amount)));
    }
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
  if (await page.locator(".till-phone").isVisible()) {
    await press(page.locator(".till-phone .phone-sticky-btn", { hasText: /Close the till/i }));
    const confirm = page.locator(".till-sheet .till-save");
    await expect(confirm).toBeVisible();
    await press(confirm);
    return;
  }
  const drawer = page.locator(".win.show.active");
  await press(drawer.getByRole("button", { name: /Close day & lock book/i }).first());
  await press(drawer.getByRole("button", { name: /Close day & lock book/i }).last());
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
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();
  const book = ledger(page);
  await openTill(page);
  if (await skip.isVisible({ timeout: 1_000 }).catch(() => false)) await skip.click();

  const before = await book.till();
  await countTheBook(page, before);
  await postFortyCad(page, "stale-close-seam-390");
  await closeTheDay(page);

  await expect(page.getByText(MESSAGE)).toBeVisible({ timeout: 15_000 });
  const again = page.locator(".till-phone .phone-error").getByRole("button", { name: "Count again" });
  await expect(again).toBeVisible();
  await expect(page.locator(".till-phone .phone-error").getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("stale-close-390.png") });
  fs.mkdirSync("/opt/cursor/artifacts/pr116", { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/opt/cursor/artifacts/pr116/stale_390.png" });
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(page.getByText(MESSAGE)).toBeVisible();
  await page.screenshot({ path: "/opt/cursor/artifacts/pr116/stale_360.png" });
  await phoneSweep(page, { roots: [".till-phone", ".phone-head", "#phone-dock"] });
  await again.click();
  await expect(page.locator(".till-phone .phone-seg-btn", { hasText: "Count" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".till-phone .phone-chip.is-on")).toContainText(/^CAD/);
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
