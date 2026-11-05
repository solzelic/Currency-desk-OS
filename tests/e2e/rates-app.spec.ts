/* Rates v2.5, the desk side: one Rates app in place of the framed York FX
   Rate Board page. The board is this desk's own server board; Publish goes
   to /api/rates/publish; "What customers see now" is the last publish,
   never the draft. A teller sees the rates and cannot change them. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

test.describe.configure({ mode: "serial" });

async function openRates(page: Page, staffId: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAtDesk(page, staffId);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.evaluate(() => (window as unknown as { CDOS: { openApp: (id: string) => void } }).CDOS.openApp("rates"));
  await expect(page.locator("[data-rates]")).toBeVisible({ timeout: 30_000 });
}

const board = (page: Page) => page.evaluate(async () => (await (await fetch("/api/rates")).json()).board);
const toggle = (page: Page, code: string) => page.getByRole("switch", { name: `${code} on the board` });

test("a manager takes a currency off the board and publishes it, and customers see the publish, not the draft", async ({ page }) => {
  await openRates(page, "r.haddad");
  await expect(page.getByRole("tablist", { name: "Rates" }).getByRole("tab")).toHaveText(["Board", "Website & window", "Pricing & rates"]);
  await expect(page.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  /* Each row shows the currency's flag and name, as the design does. */
  const usd = page.getByLabel("USD US Dollar");
  await expect(usd).toBeVisible();
  expect(await usd.locator('[aria-hidden="true"]').first().evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("/assets/flags/us.svg");
  /* The board this test found, put back exactly at the end even if the
     test fails: later files price their tills off this seed board, and a
     publish from here carries today's market rates. */
  const found = await board(page);
  try {
    /* What customers see now is the first six of the published board, in
       its order, and the order depends on what published last (CI's board
       is alphabetical). Take the first currency shown there. */
    const code: string = (found.order ?? Object.keys(found.rows)).filter((c: string) => found.rows[c] && found.rows[c].show !== false)[0];
    expect(code, "the published board shows at least one currency").toBeTruthy();
    await expect(page.getByRole("region", { name: "What customers see now" })).toContainText(code);
    await toggle(page, code).click();
    await expect(page.getByText("Unpublished changes")).toBeVisible();
    await expect(page.getByText("Your changes aren't live yet.")).toBeVisible();
    const preview = page.getByRole("region", { name: "What customers see now" });
    await expect(preview).toContainText(code);

    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Published · your site and window updated");
    await expect(page.getByText("Live on your site and window")).toBeVisible();
    const after = await board(page);
    expect(after.publicationId).not.toBe(found.publicationId);
    expect(after.rows[code].show).toBe(false);
    expect(after.publishedBy).toBe("r.haddad");
  } finally {
    const restored = await page.evaluate(async (b) => (await fetch("/api/rates/publish", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyMargin: b.buyMargin, sellMargin: b.sellMargin, rows: b.rows, ...(b.order ? { order: b.order } : {}) }),
    })).status, found);
    expect(restored, "the board this test found is published again").toBe(200);
  }
});

test("a manager switches Auto-publish on and off, and the rail says the board follows the market", async ({ page }) => {
  await openRates(page, "r.haddad");
  const auto = page.getByRole("switch", { name: "Auto-publish" });
  await expect(auto).toHaveAttribute("aria-checked", "false");
  const on = page.waitForResponse((r) => r.url().endsWith("/api/rates/auto-publish") && r.request().method() === "PUT");
  await auto.click();
  expect((await on).status()).toBe(200);
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText(/^Auto · updates with the market · last /)).toBeVisible();
  expect((await page.evaluate(async () => (await fetch("/api/rates")).json())).autoPublish).toBe(true);
  /* Put it back: the sync would otherwise republish this shared board. */
  const off = page.waitForResponse((r) => r.url().endsWith("/api/rates/auto-publish") && r.request().method() === "PUT");
  await auto.click();
  expect((await off).status()).toBe(200);
  await expect(auto).toHaveAttribute("aria-checked", "false");
});

/* The design orders the board by dragging a row's dotted handle. A mouse
   uses the browser's drag and drop; a finger or a pen does not have one,
   so the handle follows the pointer itself. Dropping a row on the one
   below it moves it one place down. Nothing is published here. */
const HANDLE = "Drag to reorder (or Alt and the arrow keys)";
const order = (page: Page) => page.getByTitle(HANDLE).evaluateAll((els) => els.map((el) => (el.closest("[aria-label]")?.getAttribute("aria-label") ?? "").split(" ")[0]));
async function fingerDrag(page: Page, from: number, to: number): Promise<void> {
  const handle = page.getByTitle(HANDLE).nth(from);
  const target = page.getByTitle(HANDLE).nth(to);
  /* A finger lands on what is on screen: both rows in view first, and
     clear of a phone's bottom bar. */
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await handle.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const a = (await handle.boundingBox())!, b = (await target.boundingBox())!;
  const at = (box: { x: number; y: number; width: number; height: number }) => ({ clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  await handle.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 11, isPrimary: true, button: 0, ...at(a) });
  await target.dispatchEvent("pointermove", { pointerType: "touch", pointerId: 11, isPrimary: true, ...at(b) });
  await target.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 11, isPrimary: true, button: 0, ...at(b) });
}

test("a manager drags a currency with a finger by its handle, on the table and on a phone", async ({ page }) => {
  await openRates(page, "r.haddad");
  await expect(page.getByTitle(HANDLE).first()).toBeVisible();
  const before = await order(page);
  expect(before.length).toBeGreaterThan(2);
  await fingerDrag(page, 0, 1);
  await expect.poll(() => order(page)).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(page.getByText("Unpublished changes")).toBeVisible();

  /* A phone shows cards; each card has the handle too. The table's
     column heads are gone once the cards are drawn. */
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("On board", { exact: true })).toBeHidden();
  await expect(page.getByTitle(HANDLE).first()).toBeVisible();
  const phone = await order(page);
  await fingerDrag(page, 1, 2);
  await expect.poll(() => order(page)).toEqual([phone[0], phone[2], phone[1], ...phone.slice(3)]);
});

/* The design's currency panel: a row's › opens it. Market, what the desk
   sells at, the margin against the floor and target, the currency's own
   spread (or the default), and on or off the board. Every change is a
   draft until Publish, and the test puts the spread back. */
test("a manager opens a currency's panel, gives it its own spread, and takes it off the board", async ({ page }) => {
  await openRates(page, "r.haddad");
  await expect(page.getByTitle(HANDLE).first()).toBeVisible();
  const code = (await order(page))[0];
  await page.getByRole("button", { name: `Open ${code}`, exact: true }).click();
  const panel = page.getByRole("dialog", { name: new RegExp(`^${code} `) });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("Market", { exact: true })).toBeVisible();
  await expect(panel.getByText("You sell at", { exact: true })).toBeVisible();
  await expect(panel).toContainText(/Floor \d+\.\d%, target \d+\.\d%\./);

  const own = panel.getByRole("switch", { name: "Use the default spread" });
  await expect(own).toHaveAttribute("aria-checked", "true");
  await own.click();
  try {
    await expect(own).toHaveAttribute("aria-checked", "false");
    const value = panel.getByLabel("Spread", { exact: true });
    const before = parseFloat((await value.textContent()) ?? "");
    await panel.getByRole("button", { name: "Raise the spread" }).click();
    await expect(value).toHaveText(`${(before + 0.1).toFixed(1)}%`);
    await expect(page.getByText("Unpublished changes")).toBeVisible();
  } finally {
    /* Back to the default spread: the setting is the shop's, saved. */
    if ((await own.getAttribute("aria-checked")) === "false") await own.click();
    await expect(own).toHaveAttribute("aria-checked", "true");
  }

  await panel.getByRole("button", { name: "Take off the board" }).click();
  await expect(page.getByRole("switch", { name: `${code} on the board` })).toHaveAttribute("aria-checked", "false");
  await panel.getByRole("button", { name: "Put on the board" }).click();
  await expect(page.getByRole("switch", { name: `${code} on the board` })).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("a teller opens a currency's panel and cannot change it", async ({ page }) => {
  await openRates(page, "m.costa");
  await page.getByRole("button", { name: "Open USD", exact: true }).click();
  const panel = page.getByRole("dialog", { name: /^USD / });
  await expect(panel.getByRole("switch", { name: "Use the default spread" })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Take off the board" })).toBeDisabled();
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toBeHidden();
});

/* The design's Lock rates: the button turns amber and says Locked, a bar
   says the rates are locked with Unlock beside it, and the board cannot
   be changed or published until a manager unlocks it. The server refuses
   a publish while locked whatever the screen does. */
test("a manager locks the rates, the board stops taking changes, and Unlock opens it again", async ({ page }) => {
  await openRates(page, "r.haddad");
  await expect(page.getByTitle(HANDLE).first()).toBeVisible();
  const lock = page.getByRole("button", { name: "Lock rates", exact: true });
  const banner = page.getByText("Rates are locked. Unlock them to make changes.");
  try {
    const locked = page.waitForResponse((r) => r.url().endsWith("/api/rates/lock") && r.request().method() === "PUT");
    await lock.click();
    expect((await locked).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
    await expect(banner).toBeVisible();
    await expect(page.getByRole("switch", { name: "USD on the board" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "Auto-publish" })).toBeDisabled();
    expect((await page.evaluate(async () => (await fetch("/api/rates")).json())).locked).toMatchObject({ by: "r.haddad" });

    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(banner).toBeHidden();
    await expect(lock).toBeVisible();
    await expect(page.getByRole("switch", { name: "USD on the board" })).toBeEnabled();
  } finally {
    /* Never leave the shared desk locked. */
    await page.evaluate(() => fetch("/api/rates/lock", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locked: false }) }));
  }
});

/* One lock. The desk's top bar had its own lock, kept in this browser
   only: it held this desk's prices and nobody else knew. Both buttons
   now lock the branch on the server, and each shows what the other did. */
test("the desk's top-bar lock and the Rates lock are the same lock", async ({ page }) => {
  await openRates(page, "r.haddad");
  await expect(page.getByTitle(HANDLE).first()).toBeVisible();
  const top = page.getByTitle("Lock rates for this branch", { exact: true });
  try {
    const locked = page.waitForResponse((r) => r.url().endsWith("/api/rates/lock") && r.request().method() === "PUT");
    await top.click();
    expect((await locked).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Locked", exact: true })).toBeVisible();
    await expect(page.getByText("Rates are locked. Unlock them to make changes.")).toBeVisible();

    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.getByTitle("Lock rates for this branch", { exact: true })).toBeVisible();
    expect((await page.evaluate(async () => (await fetch("/api/rates")).json())).locked).toBeNull();
  } finally {
    await page.evaluate(() => fetch("/api/rates/lock", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ locked: false }) }));
  }
});

/* Pricing & rates offers what the server allows: a teller only sees it,
   a manager prices but the guardrails are the owner's. */
test("Pricing & rates: a teller sees it and cannot change it; a manager cannot change the guardrails", async ({ page, browser }) => {
  await openRates(page, "m.costa");
  await page.getByRole("tab", { name: "Pricing & rates" }).click();
  await expect(page.getByText("You can see the shop's pricing. Changing it is for the owner and managers.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Pricing" }).locator("input").first()).toBeDisabled();

  const manager = await (await browser.newContext()).newPage();
  await openRates(manager, "r.haddad");
  await manager.getByRole("tab", { name: "Pricing & rates" }).click();
  await expect(manager.getByText("The guardrails are the owner's. You can change the rest.")).toBeVisible();
  await expect(manager.getByRole("group", { name: "Margin guardrails" }).locator("input").first()).toBeDisabled();
  await expect(manager.getByRole("group", { name: "Pricing" }).locator('input[type="number"]').first()).toBeEnabled();
  await manager.close();
});

test("a teller sees today's rates and cannot change or publish them", async ({ page }) => {
  await openRates(page, "m.costa");
  await expect(page.getByText("You can see today's rates. Changing them is for the owner and managers.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  await expect(toggle(page, "USD")).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Auto-publish" })).toBeDisabled();
  const refused = await page.evaluate(async () => (await fetch("/api/rates/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ buyMargin: 0.01, sellMargin: 0.01, rows: { USD: { mid: 1.3 } } }),
  })).status);
  expect(refused).toBe(403);
});

test("shots: the Rates board at 360, 390, 430, 600, 1280 and 1440, light and dark", async ({ page }) => {
  test.skip(process.env.RATES_SHOTS !== "1", "set RATES_SHOTS=1 to write the PR shots");
  for (const theme of ["light", "dark"] as const) {
    /* Fresh window per theme, widest first: a window shrunk to a phone
       does not grow back when the viewport does. */
    await openRates(page, "r.haddad");
    await page.evaluate((t) => (window as unknown as { CDOS: { theme: { set: (v: string) => void } } }).CDOS.theme.set(t), theme);
    for (const width of [1440, 1280, 600, 430, 390, 360]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `docs/pr-shots/rates-app/board-${width}-${theme}.png` });
    }
  }
});
