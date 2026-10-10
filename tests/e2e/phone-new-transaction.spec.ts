/* New transaction on a phone. At 390 and 360 the + opens a full-screen
   page. At 1280 it is still the floating dialog. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk, landOnDesktop } from "./fixtures";

const TYPES: Array<[string, RegExp]> = [
  ["Exchange", /Pays in/],
  ["Send money", /Beneficiary name/],
  ["Pay out", /Transfer \/ tracking reference/],
  ["Cash cheque", /Cheque number/],
  ["Money order", /Payee/],
  ["Pay a bill", /Biller/],
];

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function atDesk(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page);
  await dismissTour(page);
  await settled(page);
}

async function openTill(page: Page, phone = true): Promise<void> {
  const opened = await page.evaluate(async () => {
    const probe = await fetch("/api/ledger/till-session", { credentials: "same-origin" });
    if (probe.status === 404) return "no-ledger";
    const body = await probe.json().catch(() => ({}));
    if (body.session && body.session.status === "open") return "open";
    const res = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: "{}",
    });
    if (res.ok || res.status === 409) return "open";
    return `${res.status} ${await res.text()}`;
  });
  expect(opened, "the till did not open").toBe("open");
  const sync = page.waitForResponse((r) => r.url().includes("/api/ledger/till-session") && r.ok());
  await page.reload();
  await landOnDesktop(page);
  await sync;
  await dismissTour(page);
  await settled(page);
  if (phone) await expect(page.locator(".phone-till")).toContainText("Till open");
}

async function openNew(page: Page): Promise<void> {
  await page.locator("#phone-fab").click();
  const screen = page.locator(".tx-screen");
  await expect(screen.getByText("New transaction", { exact: true })).toBeVisible();
  await expect(screen.locator(".tx-idstatus")).toHaveText("No ID needed");
}

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector(".tx-screen");
    if (!root) return ["missing screen"];
    const vw = document.documentElement.clientWidth;
    const hits: string[] = [];
    const nodes = [root, ...root.querySelectorAll("*")];
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right > vw + 1 || r.left < -1) {
        const name = (el.className && String(el.className).slice(0, 80)) || el.tagName;
        hits.push(`${name} ${Math.round(r.left)}..${Math.round(r.right)}`);
      }
      if (hits.length >= 8) break;
    }
    return hits;
  });
}

async function shell(page: Page): Promise<void> {
  const fit = await page.evaluate(() => {
    const panel = document.querySelector(".tx-panel");
    const head = document.querySelector(".phone-head");
    const dock = document.getElementById("phone-dock");
    if (!(panel instanceof HTMLElement) || !(head instanceof HTMLElement)) return null;
    const box = panel.getBoundingClientRect();
    const top = head.getBoundingClientRect().bottom;
    return {
      x: box.x,
      y: box.y,
      w: box.width,
      h: box.height,
      top,
      vw: window.innerWidth,
      vh: window.innerHeight,
      radius: getComputedStyle(panel).borderRadius,
      dock: dock ? getComputedStyle(dock).display : "missing",
    };
  });
  expect(fit, "the page did not measure").not.toBeNull();
  expect(fit!.x).toBeLessThanOrEqual(1);
  expect(fit!.w).toBeGreaterThanOrEqual(fit!.vw - 1);
  expect(Math.abs(fit!.y - fit!.top)).toBeLessThanOrEqual(2);
  expect(fit!.y + fit!.h).toBeGreaterThanOrEqual(fit!.vh - 2);
  expect(fit!.radius).toBe("0px");
  expect(fit!.dock).toBe("none");
  await expect(page.locator(".tx-typegrid")).toBeHidden();
  await expect(page.locator(".tx-typecard")).toBeVisible();
  await expect(page.locator(".tx-close-back")).toBeVisible();
  await expect(page.locator("#phone-fab")).toBeHidden();
}

test("a phone opens a full-screen page, and a missing deal stays disabled", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await openTill(page);
  await openNew(page);
  await shell(page);

  const blocked = page.locator(".tx-record");
  await expect(blocked).toBeDisabled();
  await expect(blocked).toContainText(/\d+ to complete/);
  await expect(page.locator(".tx-ready-narrow")).toContainText(/\d+ left/);
  expect(await overflow(page)).toEqual([]);

  const note = page.getByPlaceholder(/Anything worth keeping/);
  await note.focus();
  const place = await page.evaluate(() => {
    const el = document.activeElement;
    const actions = document.querySelector(".tx-actions");
    if (!(el instanceof HTMLElement) || !(actions instanceof HTMLElement)) return null;
    const field = el.getBoundingClientRect();
    const bar = actions.getBoundingClientRect();
    return { top: field.top, bottom: field.bottom, bar: bar.top, vh: window.innerHeight };
  });
  expect(place, "the focused field did not measure").not.toBeNull();
  expect(place!.top).toBeGreaterThanOrEqual(0);
  expect(place!.bottom).toBeLessThanOrEqual(place!.bar + 1);
});

for (const width of [390, 360]) {
  test(`each deal type fits a ${width}px phone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page);
    await openTill(page);
    await openNew(page);
    for (const [name, marker] of TYPES) {
      await page.locator(".tx-typecard").click();
      const sheet = page.locator(".tx-sheet");
      await expect(sheet).toBeVisible();
      const row = sheet.getByRole("option", { name });
      const box = await row.boundingBox();
      expect(box && box.height, name).toBeGreaterThanOrEqual(44);
      await row.click();
      await expect(sheet).toBeHidden();
      await expect(page.locator(".tx-typecard-now")).toHaveText(name);
      await expect(page.locator(".tx-screen").getByText(marker).first()).toBeVisible();
      await shell(page);
      expect(await overflow(page), name).toEqual([]);
    }
  });
}

test("an exchange can be filled and recorded, and the ledger keeps it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page);
  await openTill(page);
  const floated = await page.evaluate(async () => {
    const post = (currency: string, amount: string) =>
      fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          idempotencyKey: `phone-${currency}-${Date.now()}`,
          direction: "in",
          currency,
          amount,
          counterpartyType: "bank",
          counterpartyRef: "phone float",
          reason: "Cash for a phone exchange",
        }),
      }).then((r) => r.status);
    return { cad: await post("CAD", "200.00"), usd: await post("USD", "500.00") };
  });
  expect(floated, "the till was not floated").toEqual({ cad: 201, usd: 201 });

  await openNew(page);
  const customer = `Phone Deal ${Date.now()}`;
  await page.getByPlaceholder("Type a name…").fill(customer);
  await page.locator(".tx-title").click();
  await page.locator(".tx-screen input.tx-amt").fill("100");
  await page.getByPlaceholder("e.g. travel").fill("Personal travel");
  await page.getByPlaceholder("e.g. savings").fill("Employment income");
  const quote = page.locator(".tx-record");
  await expect(quote).toBeEnabled();
  await expect(quote).toContainText("Get server quote");
  await quote.click();
  await expect(quote).toContainText("Post frozen quote");
  await quote.click();

  await expect(page.locator(".tx-screen")).toBeHidden();
  await expect(page.getByText(customer).first()).toBeVisible();
  await expect(page.getByText("Posted", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".tx-flow").getByText("We received").first()).toBeVisible();

  const book = await page.evaluate(() =>
    fetch("/api/ledger/transactions?limit=20", { credentials: "same-origin" }).then((r) => r.json()),
  );
  expect(
    book.transactions.some(
      (row: { from: string; to: string; inputAmount: string; purpose: string }) =>
        row.from === "CAD" && row.to === "USD" && row.inputAmount === "100.00" && row.purpose === "Personal travel",
    ),
    JSON.stringify(book.transactions?.slice?.(0, 3)),
  ).toBe(true);
});

test("a wide window still uses the floating dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page);
  await openTill(page, false);
  await expect(page.locator("#phone-dock")).toBeHidden();
  await page.getByRole("button", { name: /^New transaction$/ }).first().click();
  const panel = page.locator(".tx-panel");
  await expect(panel.getByText("New transaction", { exact: true })).toBeVisible();
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(940);
  expect(box!.width).toBeGreaterThan(700);
  expect(box!.x).toBeGreaterThan(40);
  const radius = await panel.evaluate((el) => getComputedStyle(el).borderRadius);
  expect(radius).not.toBe("0px");
  await expect(page.locator(".tx-typecard")).toBeHidden();
  await expect(page.locator(".tx-typegrid")).toBeVisible();
  await expect(panel.getByText("Customer pays in", { exact: true })).toBeVisible();
  await expect(panel.locator(".tx-narrow").first()).toBeHidden();
  await expect(panel.getByRole("button", { name: "Exchange", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Cancel" })).toBeVisible();
});
