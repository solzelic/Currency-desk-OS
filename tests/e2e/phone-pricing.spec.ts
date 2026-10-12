/* Phone Pricing. The list, the spread sheet, and publish.
   Desktop pixels belong to tests/e2e/desktop-unchanged.spec.ts.
   This file does not add or replace a 1280 baseline. */
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const SHOTS = "/opt/cursor/artifacts/pr117";
const PHONE_ROOTS = [".pr-phone", ".phone-head", "#phone-dock"];

async function dismissTour(page: Page): Promise<void> {
  const skip = page.locator(".cdos-tour-skip");
  for (let i = 0; i < 15; i++) {
    if (await skip.isVisible()) {
      await skip.click();
      break;
    }
    await page.waitForTimeout(200);
  }
}

async function atDesk(page: Page, staffId: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/app");
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await signInAtDesk(page, staffId);
  await dismissTour(page);
  await expect(page.locator(".win.show.active").first()).toHaveCSS("transform", "none");
}

async function openPricing(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="pricing"]').click();
  await dismissTour(page);
  await expect(page.locator(".pr-phone")).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
  } catch (err) {
    console.error("pricing screenshot skipped", name, err);
  }
}

async function frames(page: Page, name: string): Promise<void> {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await shot(page, `${name}_${width}`);
  }
}

function ratesGet(url: string, method: string): boolean {
  const path = new URL(url).pathname;
  return method === "GET" && path === "/api/rates";
}

/* The pixel proof is desktop-unchanged.spec.ts. This only checks
   that the phone column is not what a wide window mounts. */
test("desktop pricing does not mount the phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page, "j.masri");
  await page.locator('#appbar [data-app="pricing"]').click();
  const win = page.locator(".win.show.active");
  await expect(win.locator(".win-title")).toContainText(/Pricing/);
  await expect(win).toHaveCSS("transform", "none");
  await expect(page.locator(".pr-phone")).toHaveCount(0);
  await expect(page.locator(".pr-sheet")).toHaveCount(0);
  const button = win.getByRole("button", { name: "Publish to Rate Board" });
  const height = await button.evaluate((el) => el.getBoundingClientRect().height);
  expect(height).toBeLessThan(40);
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/pricing_desktop_1280.png` });
    await win.screenshot({ path: `${SHOTS}/pricing_desktop_window_1280.png`, animations: "disabled", caret: "hide" });
  } catch (err) {
    console.error("pricing desktop screenshot skipped", err);
  }
});

for (const width of [360, 390]) {
  test(`pricing list at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='loading']")).toHaveCount(0);
    const phone = page.locator(".pr-phone");
    await expect(phone.getByRole("heading", { name: "Pricing", exact: true })).toBeVisible();
    await expect(phone).toContainText("Changes save as you go. Publish to show them on the rate board.");
    await expect(phone).toContainText("For every currency");
    await expect(phone).toContainText("Spread by currency");
    await expect(phone).toContainText("Added on each side of the market rate");
    await expect(phone).toContainText("Warn when a deal earns under this");
    await expect(phone).toContainText("USD");
    await expect(phone).toContainText("0.00 CAD");
    await expect(phone).not.toContainText("Example data");
    await expect(phone).not.toContainText("$");
    await expect(phone.locator(".phone-badge").first()).toHaveText(/^(Connected|Not connected|Stale)$/);
    const names = await page.locator(".pr-ccy").evaluateAll((els) => {
      const display = new Intl.DisplayNames(["en"], { type: "currency" });
      return els.map((el) => {
        const code = (el.querySelector(".phone-row-title")?.textContent || "").trim();
        const name = (el.querySelector(".phone-row-sub")?.textContent || "").trim();
        let expected = "";
        try {
          expected = display.of(code) || "";
        } catch (err) {
          expected = "";
        }
        return { code, name, expected };
      });
    });
    expect(names.length).toBeGreaterThan(0);
    for (const row of names) {
      expect(row.name, row.code).not.toBe("");
      expect(row.name.toUpperCase(), row.code).not.toBe(row.code);
      expect(row.name, row.code).toBe(row.expected);
    }
    const shown = await phone.innerText();
    expect(shown).not.toMatch(/\blive\b/i);
    await expect(page.locator("#phone-fab")).toHaveCount(0);
    const row = await phone.locator(".phone-row").first().boundingBox();
    expect(row && row.height).toBeGreaterThanOrEqual(44);
    const publish = page.locator(".pr-phone .phone-sticky-btn");
    await expect(publish).toHaveText("Publish to Rate Board");
    await expect(publish).toBeDisabled();
    await expect(phone).toContainText("Nothing new to put on the rate board.");
    const box = await publish.boundingBox();
    expect(box && box.height).toBeGreaterThanOrEqual(48);
    const back = phone.locator(".pr-back");
    const backBox = await back.boundingBox();
    expect(backBox && backBox.height).toBeGreaterThanOrEqual(44);
    expect(backBox && backBox.width).toBeGreaterThanOrEqual(44);
    await shot(page, `pricing_list_${width}`);
    if (width === 360) {
      await back.click();
      await expect(page.locator("#phone-more")).toBeVisible();
    }
  });

  test(`stepper preview matches priceDeal at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='list']")).toBeVisible();
    const usdName = await page.locator(".pr-ccy").evaluateAll((els) => {
      const row = els.find((el) => (el.querySelector(".phone-row-title")?.textContent || "").trim() === "USD");
      return row ? (row.querySelector(".phone-row-sub")?.textContent || "").trim() : "";
    });
    expect(usdName.toUpperCase()).not.toBe("USD");
    await page.getByRole("button", { name: /USD/ }).click();
    const sheet = page.getByRole("dialog", { name: usdName + " spread" });
    await expect(sheet).toBeVisible();
    const before = await sheet.locator("[data-pr='buy']").innerText();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await sheet.getByRole("button", { name: "Less, 0.1" }).click();
    await expect(sheet.getByRole("button", { name: "Save 1.2% for USD" })).toBeVisible();
    const expected = await page.evaluate(() => {
      const C = window.CDOS;
      const home = C.deskHomeCcy();
      const raw = localStorage.getItem("cdos_settings");
      const settings = raw ? JSON.parse(raw) : {};
      const next = Object.assign({}, settings, {
        spreads: Object.assign({}, settings.spreads || {}, { USD: 1.2 }),
      });
      const mid = C.unitCadMid("USD");
      const known = mid > 0 && Number.isFinite(mid);
      const deal = C.priceDeal({ inCcy: "USD", outCcy: home, inAmt: 500, settings: next });
      const money = (n: number) => C.formatPhoneMoney(n, home) || "—";
      return {
        known,
        buy: known ? C.buyUnitCad("USD", next).toFixed(4) : "—",
        sell: known ? C.sellUnitCad("USD", next).toFixed(4) : "—",
        mid: known ? Number(mid).toFixed(4) : "—",
        gets: known ? money(deal.outAmt) : "—",
        earn: known ? money(deal.marginCad) : "—",
      };
    });
    await expect(sheet.locator("[data-pr='buy']")).toHaveText(expected.buy);
    await expect(sheet.locator("[data-pr='sell']")).toHaveText(expected.sell);
    await expect(sheet.locator("[data-pr='mid']")).toHaveText(expected.mid);
    await expect(sheet.locator("[data-pr='gets']")).toHaveText(expected.gets);
    await expect(sheet.locator("[data-pr='earn']")).toHaveText(expected.earn);
    if (expected.known) expect(expected.buy).not.toBe(before);
    const buy = await sheet.locator("[data-pr='buy']").evaluate((el) => getComputedStyle(el).color);
    const sell = await sheet.locator("[data-pr='sell']").evaluate((el) => getComputedStyle(el).color);
    expect(buy).toBe("rgb(30, 90, 168)");
    expect(sell).toBe("rgb(122, 62, 150)");
    await expect(sheet).toContainText("Nothing changes on the Rate Board until you tap Publish.");
    await expect(sheet).toContainText("Market rate now");
    const sheetText = await sheet.innerText();
    expect(sheetText).not.toMatch(/\blive\b/i);
    await shot(page, `pricing_stepper_${width}`);
  });

  test(`publish hits the rate board once at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const posts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/rates/publish") posts.push(req.url());
    });
    await atDesk(page, "j.masri");
    await openPricing(page);
    await expect(page.locator("[data-pr='list']")).toBeVisible();
    const button = page.locator(".pr-phone .phone-sticky-btn");
    await expect(button).toBeDisabled();
    await page.getByRole("button", { name: /USD/ }).click();
    await page.getByRole("button", { name: "Less, 0.1" }).click();
    await page.getByRole("button", { name: /Save / }).click();
    await expect(page.locator(".pr-phone")).toContainText("1 change not on the rate board yet.");
    await expect(button).toBeEnabled();
    const done = page.waitForResponse(
      (res) => new URL(res.url()).pathname === "/api/rates/publish" && res.request().method() === "POST",
    );
    await button.click();
    const res = await done;
    expect(res.status()).toBe(200);
    await expect(page.locator("[data-pr='toast']")).toContainText(/Sent to the Rate Board\./);
    await expect(page.locator("[data-pr='toast']")).toContainText(/\d+ currencies, \d{1,2}:\d{2} (AM|PM)\./);
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    await page.waitForTimeout(400);
    expect(posts).toHaveLength(1);
    await shot(page, `pricing_toast_${width}`);
  });

  test(`pricing shows skeletons while the board loads at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    let hold = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/rates**", async (route) => {
      if (hold && ratesGet(route.request().url(), route.request().method())) await gate;
      await route.continue();
    });
    await atDesk(page, "j.masri");
    hold = true;
    await openPricing(page);
    await expect(page.locator("[data-pr='loading']")).toBeVisible();
    await expect(page.getByRole("status", { name: "Loading pricing" })).toBeVisible();
    await expect(page.locator(".pr-phone .phone-sticky-btn")).toBeDisabled();
    await shot(page, `pricing_loading_${width}`);
    if (width === 390) await phoneSweep(page, { roots: PHONE_ROOTS });
    release();
  });
}

test("a failed board load keeps the saved spreads", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await page.route("**/api/rates**", async (route) => {
    if (ratesGet(route.request().url(), route.request().method())) {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await atDesk(page, "j.masri");
  await openPricing(page);
  await expect(page.getByRole("alert")).toContainText("The Rate Board didn't load.");
  await expect(page.locator("[data-pr='list']")).toContainText("USD");
  await expect(page.locator("[data-pr='list']")).toContainText("Not connected");
  await frames(page, "pricing_error");
  await phoneSweep(page, { roots: PHONE_ROOTS });
});

test("no foreign currencies is an empty state", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  await atDesk(page, "j.masri");
  await page.evaluate(() => {
    window.CDOS.deskCurrencyList = () => ["CAD"];
  });
  await openPricing(page);
  await expect(page.locator("[data-pr='empty']")).toContainText("No currencies yet");
  await expect(page.locator(".pr-phone .phone-sticky")).toHaveCount(0);
});

test("pricing passes the phone sweep", async ({ page }) => {
  test.setTimeout(180_000);
  /* Installed before the desk opens so the toast timer is fake.
     Time keeps moving until the toast is on screen, then it pauses,
     so the four-second note is still there while both widths are checked. */
  await page.clock.install({ time: new Date() });
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await openPricing(page);
  await expect(page.locator("[data-pr='list']")).toBeVisible();
  await frames(page, "pricing_list");
  await phoneSweep(page, { roots: PHONE_ROOTS });

  await page.getByRole("button", { name: /USD/ }).click();
  await expect(page.locator("[data-pr='sheet']")).toBeVisible();
  await frames(page, "pricing_stepper");
  await phoneSweep(page, { roots: [".pr-sheet"] });
  await page.getByRole("button", { name: "Less, 0.1" }).click();
  await page.getByRole("button", { name: /Save / }).click();
  await expect(page.locator("[data-pr='sheet']")).toHaveCount(0);
  await expect(page.locator(".pr-phone")).toContainText("1 change not on the rate board yet.");

  let releasePublish: () => void = () => {};
  const publishGate = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  await page.route("**/api/rates/publish", async (route) => {
    if (route.request().method() === "POST") await publishGate;
    await route.continue();
  });
  await page.locator(".pr-phone .phone-sticky-btn").click();
  const publishing = page.locator(".pr-phone.is-publishing .phone-sticky-btn");
  await expect(publishing).toHaveText("Publishing…");
  await expect(publishing).toBeDisabled();
  const ink = await publishing.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(ink).toBe("rgb(39, 75, 142)");
  await frames(page, "pricing_publish");
  await phoneSweep(page, { roots: PHONE_ROOTS });
  releasePublish();
  await expect(page.locator("[data-pr='toast']")).toBeVisible();
  const frozen = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(frozen + 200);
  await frames(page, "pricing_toast");
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 844 });
    try {
      mkdirSync(SHOTS, { recursive: true });
      await page.locator("[data-pr='toast']").screenshot({ path: `${SHOTS}/pricing_toast_bar_${width}.png` });
    } catch (err) {
      console.error("pricing toast bar skipped", width, err);
    }
  }
  await phoneSweep(page, { roots: [...PHONE_ROOTS, "[data-pr='toast']"] });
});

test("a teller cannot publish", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 844 });
  const posts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/rates/publish") posts.push(req.url());
  });
  await atDesk(page, "m.costa");
  await openPricing(page);
  await expect(page.locator("[data-pr='list']")).toBeVisible();
  const button = page.locator(".pr-phone .phone-sticky-btn");
  await expect(button).toBeDisabled();
  await expect(page.locator(".pr-phone")).toContainText("Only an owner or a manager can publish.");
  await button.click({ force: true });
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);
  await frames(page, "pricing_teller");
  await phoneSweep(page, { roots: PHONE_ROOTS });
});
