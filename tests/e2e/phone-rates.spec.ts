/* Phone Rates. The board editor under 430px. Wider than that, Rates
   stays the Rate Board iframe, and this file does not touch that picture. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };
const REFUSED = "The server refused (403). Only a manager or an admin can publish rates.";

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
  await page.setViewportSize(PHONE);
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

async function openRates(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="rates"]').click();
  await dismissTour(page);
  await expect(page.locator('.phone-rates [data-code="USD"]')).toBeVisible();
}

async function assertNoDash(page: Page): Promise<void> {
  const text = await page.locator(".phone-rates").innerText();
  expect(text).not.toContain("\u2014");
  expect(text).not.toContain("\u2013");
}

test("buy and sell follow the desk formula", async ({ page }) => {
  await atDesk(page, "r.haddad");
  const result = await page.evaluate(() => {
    const rates = window.CDOS.phoneRates;
    const body = rates.publishBody({
      buyMargin: 0.015,
      sellMargin: 0.015,
      order: ["USD"],
      rows: { USD: { mid: 1.34, show: true, spread: null, manual: true } },
    });
    return {
      buy: rates.buyPrice(1.3421, null, 0.015),
      sell: rates.sellPrice(1.3421, null, 0.015),
      custom: rates.buyPrice(1.3421, 0.02, 0.015),
      clamped: rates.clampSpot(2, 1.34),
      inside: rates.clampSpot(1.35, 1.34),
      noFeed: rates.clampSpot(1.5, null),
      name: rates.currencyName("USD"),
      inr: rates.currencyName("INR"),
      posted: JSON.stringify(body),
      order: body.order,
      teller: rates.canChangeRates("teller"),
      supervisor: rates.canChangeRates("supervisor"),
      manager: rates.canChangeRates("branch_manager"),
      admin: rates.canChangeRates("administrator"),
      refused: rates.plainPublishError(403, { detail: "rates:change required" }),
    };
  });
  expect(result.buy).toBeCloseTo(1.3421 * 0.985, 6);
  expect(result.sell).toBeCloseTo(1.3421 * 1.015, 6);
  expect(result.custom).toBeCloseTo(1.3421 * 0.98, 6);
  expect(result.clamped.value).toBeCloseTo(1.34 * 1.02, 6);
  expect(result.clamped.clamped).toBe(true);
  expect(result.inside.clamped).toBe(false);
  expect(result.noFeed.hasFeed).toBe(false);
  expect(result.name).toBe("US Dollar");
  expect(result.inr).toBe("Indian Rupee");
  expect(result.posted).not.toContain("manual");
  expect(result.order[0]).toBe("CAD");
  expect(result.teller).toBe(false);
  expect(result.supervisor).toBe(false);
  expect(result.manager).toBe(true);
  expect(result.admin).toBe(true);
  expect(result.refused).toBe(REFUSED);
});

test("a manager edits the board the server published", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  await expect(screen).toHaveAttribute("data-can-publish", "yes");
  await expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Public preview" })).toBeVisible();
  await expect(screen.getByText("Buy margin, under spot")).toBeVisible();
  await expect(screen.getByText("Sell margin, over spot")).toBeVisible();
  await expect(screen.getByText("1.50%").first()).toBeVisible();
  await expect(screen.getByRole("button", { name: "Lock rates in this browser" })).toBeVisible();
  await expect(screen.getByText("On your homepage, top 6")).toBeVisible();
  await expect(screen.getByText("Drag to reorder")).toBeVisible();
  await expect(screen.getByText("Rate board page only")).toBeVisible();
  await expect(screen.locator('[data-code="USD"]')).toContainText("US Dollar");
  await expect(screen.locator('[data-code="INR"]')).toContainText("Indian Rupee");
  await expect(screen).not.toContainText("Example data");
  await expect(screen.getByRole("button", { name: /quote|deal|new transaction/i })).toHaveCount(0);
  await assertNoDash(page);

  const before = await screen.locator('[data-code="USD"] .is-buy').innerText();
  await screen.getByRole("button", { name: "Raise Buy margin, under spot" }).click();
  await expect(screen.getByText("1.55%")).toBeVisible();
  await expect(screen.locator('[data-code="USD"] .is-buy')).not.toHaveText(before);
  await expect(screen.getByRole("button", { name: /Publish \d+ change/ })).toBeEnabled();

  await phoneSweep(page, {
    roots: [".phone-rates", ".phone-head", "#phone-dock"],
  });
});

test("a hand-set spot stays within 2% of the feed", async ({ page }) => {
  await page.route(/\/api\/rates\/market$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ provider: "test", mids: { USD: 1.34 }, fetchedAt: Date.now() }),
    });
  });
  await atDesk(page, "r.haddad");
  await openRates(page);
  await page.locator('.phone-rates [data-code="USD"] .phone-rate-main').click();
  const spot = page.getByLabel("Spot for USD");
  await spot.fill("2");
  await spot.blur();
  await expect(spot).toHaveValue("1.3668");
  await expect(page.locator(".phone-rate-pin")).toHaveText("Set by hand");
  await expect(page.locator(".phone-rates")).toContainText("Held within 2% of the feed.");
  await page.getByRole("button", { name: "Use feed spot" }).click();
  await expect(spot).toHaveValue("1.3400");
  await expect(page.locator(".phone-rate-pin")).toHaveCount(0);
});

test("public preview lists the homepage six and what is left", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  await page.locator('.phone-rates [data-code="MXN"] [role="switch"]').click();
  await page.getByRole("button", { name: "Public preview" }).click();
  const screen = page.locator(".phone-rates");
  await expect(screen).toContainText("What your homepage will show after you publish. Not live yet.");
  await expect(screen.locator(".phone-rate-board")).toContainText("TODAY'S RATES");
  await expect(screen.locator(".phone-rate-board")).toContainText("We buy");
  await expect(screen.locator(".phone-rate-board")).toContainText("We sell");
  const codes = await screen.locator(".phone-rate-board-r b").allTextContents();
  expect(codes.slice(0, 6)).toEqual(codes);
  expect(codes).not.toContain("MXN");
  await expect(screen).toContainText("MXN is hidden.");
  await assertNoDash(page);
  await phoneSweep(page, {
    roots: [".phone-rates", ".phone-head", "#phone-dock"],
  });
});

test("publish posts the board and a refused post says 403", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const before = await page.evaluate(async () => {
    const data = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
    return data.board;
  });
  try {
    await page.locator(".phone-rates").getByRole("button", { name: "Raise Buy margin, under spot" }).click();
    await page.getByRole("button", { name: /Publish \d+ change/ }).click();
    const sheet = page.getByRole("dialog", { name: "Publish rates?" });
    await expect(sheet).toContainText("These go to your website and rate board. Customers see them within about a minute.");
    await expect(sheet).toContainText("Publishing is saved with your name and the time. Only managers and admins can publish.");
    await expect(sheet).toContainText("Buy and sell margin");
    await sheet.getByRole("button", { name: "Publish now" }).click();
    await expect(page.locator(".phone-rates")).toContainText(/Published /);
    const after = await page.evaluate(async () => {
      const data = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
      return data.board;
    });
    expect(after.buyMargin).toBeCloseTo(before.buyMargin + 0.0005, 6);
    expect(after.publishedBy).toBe("r.haddad");
    await assertNoDash(page);
  } finally {
    await page.evaluate(async (board) => {
      await fetch("/api/rates/publish", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          buyMargin: board.buyMargin,
          sellMargin: board.sellMargin,
          rows: board.rows,
          order: board.order,
        }),
      });
    }, before);
  }
});

test("a refused publish shows the server 403 in the sheet", async ({ page }) => {
  await page.route(/\/api\/rates\/publish$/, async (route) => {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "permission_denied", detail: "rates:change required" }),
    });
  });
  await atDesk(page, "r.haddad");
  await openRates(page);
  await page.locator(".phone-rates").getByRole("button", { name: "Raise Sell margin, over spot" }).click();
  await page.getByRole("button", { name: /Publish \d+ change/ }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByRole("alert")).toContainText(REFUSED);
  await expect(page.getByRole("dialog", { name: "Publish rates?" })).toBeVisible();
  await phoneSweep(page, {
    roots: [".phone-rate-sheet", ".phone-head", "#phone-dock"],
  });
});

test("a teller sees the list and the server refuses the post", async ({ page }) => {
  await atDesk(page, "m.costa");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  await expect(screen).toHaveAttribute("data-can-publish", "no");
  await expect(screen).toContainText("Ask a manager to change rates");
  await expect(screen.getByText("Buy margin, under spot")).toHaveCount(0);
  await expect(screen.locator(".phone-rate-grip")).toHaveCount(0);
  await expect(screen.locator("[role='switch']")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  await expect(screen.locator('[data-code="GBP"]')).toContainText("British Pound");
  await assertNoDash(page);

  const refused = await page.evaluate(async () => {
    const data = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
    const board = data.board;
    const response = await fetch("/api/rates/publish", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buyMargin: board.buyMargin,
        sellMargin: board.sellMargin,
        rows: board.rows,
        order: board.order,
      }),
    });
    const body = await response.json();
    return { status: response.status, error: body.error, detail: body.detail };
  });
  expect(refused).toEqual({ status: 403, error: "permission_denied", detail: "rates:change required" });
  await expect(screen.getByRole("alert")).toHaveCount(0);
  await expect(screen).toContainText("Ask a manager to change rates");

  await phoneSweep(page, {
    roots: [".phone-rates", ".phone-head", "#phone-dock"],
  });
});

test("a missed board is an error, not an invented list", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await page.route(/\/api\/rates$/, async (route) => {
    await route.abort();
  });
  await page.locator('#phonebar [data-phone-app="rates"]').click();
  await dismissTour(page);
  const screen = page.locator(".phone-rates");
  await expect(screen.getByRole("alert")).toContainText("Could not reach the server. The rate board did not load.");
  await expect(screen.locator("[data-code]")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a dropped publish says nothing was published", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const before = await page.evaluate(async () => {
    const data = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
    return data.board.buyMargin as number;
  });
  await page.route(/\/api\/rates\/publish$/, async (route) => {
    await route.abort();
  });
  await page.locator(".phone-rates").getByRole("button", { name: "Raise Buy margin, under spot" }).click();
  await page.getByRole("button", { name: /Publish \d+ change/ }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not reach the server. Nothing was published.");
  const after = await page.evaluate(async () => {
    const data = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
    return data.board.buyMargin as number;
  });
  expect(after).toBeCloseTo(before, 8);
});

test("spread finds Rates and fee finds no phone app", async ({ page }) => {
  await atDesk(page, "a.singh");
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.getByRole("textbox", { name: "Search apps" }).fill("spread");
  await expect(page.locator("#phone-more .phone-more-name")).toHaveText(["Rates"]);
  await page.getByRole("textbox", { name: "Search apps" }).fill("fee");
  await expect(page.locator("#phone-more")).toContainText("No matches");
  const names = await page.locator("#phone-more .phone-more-name").allTextContents();
  expect(names).not.toContain("Pricing");
  expect(names).not.toContain("Rates");
});
