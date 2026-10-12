/* Phone Rates publish. The button posts /api/rates/publish.
   A teller and a supervisor are refused by the server. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };
const REFUSED = "Only a manager or an admin can publish rates.";

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

test("nothing to publish has no helper line", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  const idle = screen.getByRole("button", { name: "Nothing to publish" });
  await expect(idle).toBeDisabled();
  await expect(screen.locator(".phone-sticky-why")).toHaveCount(0);
  await expect(screen).not.toContainText("Nothing new to publish");
  await expect(screen).not.toContainText("Publish 0");
  await phoneSweep(page, { roots: [".phone-rates", ".phone-head", "#phone-dock"] });
  await screen.getByRole("button", { name: "Raise Buy margin, under spot" }).click();
  await expect(screen.getByRole("button", { name: "Publish 1 change" })).toBeEnabled();
  await expect(screen.locator(".phone-sticky-why")).toHaveCount(0);
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
    await page.getByRole("button", { name: "Publish 1 change" }).click();
    const sheet = page.getByRole("dialog", { name: "Publish rates?" });
    const publishNow = sheet.getByRole("button", { name: "Publish now" });
    const shape = await publishNow.evaluate((el) => {
      const button = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const pageBox = el.closest(".phone-rate-sheet")!.getBoundingClientRect();
      const body = el.closest(".phone-rate-sheet")!.querySelector(".phone-task-body") as HTMLElement;
      const back = el.closest(".phone-rate-sheet")!.querySelector(".phone-rate-back")!.getBoundingClientRect();
      return {
        background: button.backgroundColor,
        height: rect.height,
        inset: rect.left - pageBox.left,
        insetRight: pageBox.right - rect.right,
        bodyPad: getComputedStyle(body).paddingLeft,
        backLeft: back.left - pageBox.left,
      };
    });
    expect(shape.background).toBe("rgb(39, 75, 142)");
    expect(shape.height).toBeGreaterThanOrEqual(52);
    expect(shape.height).toBeLessThan(53);
    expect(shape.inset).toBeGreaterThanOrEqual(16);
    expect(shape.inset).toBeLessThan(17);
    expect(shape.insetRight).toBeGreaterThanOrEqual(16);
    expect(shape.bodyPad).toBe("16px");
    expect(shape.backLeft).toBeLessThanOrEqual(16);
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
    const text = await page.locator(".phone-rates").innerText();
    expect(text).not.toContain("\u2014");
    expect(text).not.toContain("\u2013");
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

test("a refused publish shows the plain sentence", async ({ page }) => {
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
  await page.getByRole("button", { name: "Publish 1 change" }).click();
  await page.getByRole("button", { name: "Publish now" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveText(REFUSED);
  await expect(alert).not.toContainText("rates:change required");
  const sheet = page.getByRole("dialog", { name: "Publish rates?" });
  await expect(sheet).toBeVisible();
  const shown = await sheet.innerText();
  expect(shown).not.toMatch(/\b(400|401|403|404|500)\b/);
  await phoneSweep(page, { roots: [".phone-rate-sheet", ".phone-head", "#phone-dock"] });
});

test("a teller post is refused and the board stays", async ({ page }) => {
  await atDesk(page, "m.costa");
  await openRates(page);
  const screen = page.locator(".phone-rates");
  await expect(screen.getByRole("button", { name: /Publish|Nothing to publish/ })).toHaveCount(0);
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
        rows: { USD: { mid: -5 } },
        order: board.order,
      }),
    });
    const body = await response.json();
    const again = await fetch("/api/rates", { credentials: "same-origin" }).then((r) => r.json());
    return {
      status: response.status,
      error: body.error,
      detail: body.detail,
      same: again.board.publicationId === board.publicationId,
    };
  });
  expect(refused).toEqual({
    status: 403,
    error: "permission_denied",
    detail: "Only a manager or an admin can publish rates.",
    same: true,
  });
  await expect(screen.getByRole("alert")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Publish 1 change" }).click();
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
