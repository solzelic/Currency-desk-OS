/* Phone Rates public preview. Publish is a later slice. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";
import { phoneSweep } from "./helpers/phone-sweep";

const PHONE = { width: 390, height: 844 };

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

test("public preview lists the homepage six through boardQuote", async ({ page }) => {
  await atDesk(page, "r.haddad");
  await openRates(page);
  const expected = await page.evaluate(() => {
    const rates = window.CDOS.phoneRates;
    return fetch("/api/rates", { credentials: "same-origin" })
      .then((response) => response.json())
      .then((data) => {
        const board = data.board;
        const row = board.rows.USD;
        return rates.boardQuote("USD", row.mid, row.spread, board.buyMargin, board.sellMargin);
      });
  });
  const mxn = page.locator('.phone-rates [data-code="MXN"]');
  await mxn.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await mxn.locator("[role='switch']").click();
  await page.getByRole("button", { name: "Public preview" }).click();
  const screen = page.locator(".phone-rates");
  await expect(screen).toContainText("What your homepage will show after you publish. Not live yet.");
  await expect(screen.locator(".phone-rate-board")).toContainText("TODAY'S RATES");
  await expect(screen.locator(".phone-rate-board")).toContainText("We buy");
  await expect(screen.locator(".phone-rate-board")).toContainText("We sell");
  const codes = await screen.locator(".phone-rate-board-r b").allTextContents();
  expect(codes).toHaveLength(6);
  expect(codes).not.toContain("MXN");
  expect(codes).toContain("USD");
  const usd = screen.locator(".phone-rate-board-r").filter({ hasText: "USD" });
  await expect(usd).toContainText(expected.buy);
  await expect(usd).toContainText(expected.sell);
  expect(expected.per).toBe(1);
  await expect(screen).toContainText("MXN is hidden.");
  await expect(screen.getByRole("button", { name: /Publish/ })).toHaveCount(0);
  const text = await screen.innerText();
  expect(text).not.toContain("\u2014");
  expect(text).not.toContain("\u2013");
  await phoneSweep(page, { roots: [".phone-rates", ".phone-head", "#phone-dock"] });
});

test("a teller has no public preview", async ({ page }) => {
  await atDesk(page, "m.costa");
  await openRates(page);
  await expect(page.getByRole("button", { name: "Public preview" })).toHaveCount(0);
  await expect(page.locator(".phone-rate-board")).toHaveCount(0);
});
