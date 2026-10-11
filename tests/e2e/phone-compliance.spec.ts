/* Phone Compliance. Narrow windows use the phone home once the shared
   money formatter is loaded. A wide window keeps the desktop Compliance
   window, pixel for pixel. */
import type { Page } from "@playwright/test";
import { test, expect, signInAtDesk } from "./fixtures";

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

async function openCompliance(page: Page): Promise<void> {
  await page.locator('#phonebar [data-phone-app="more"]').click();
  await page.locator('#phone-more [data-phone-app="compliance"]').click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Compliance");
}

test("desktop Compliance is unchanged at 1280", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await atDesk(page, "j.masri");
  await page.locator('#appbar [data-app="compliance"]').click();
  await expect(page.locator(".win.show.active .win-title")).toContainText("Compliance");
  await expect(page.getByTestId("compliance-phone-home")).toHaveCount(0);
  await expect(page.getByTestId("sanctions-screening-tile")).toContainText("Not connected");
  await expect(page.locator("#phonebar")).toBeHidden();
  /* Captured from the desktop Compliance window before this phone home.
     maxDiffPixels 0 is the gate: a wide window does not move. */
  await expect(page.locator(".win.show.active")).toHaveScreenshot("compliance-desktop-1280.png", {
    maxDiffPixels: 0,
    animations: "disabled",
  });
});

test("owner and teller phone homes stay honest", async ({ page }) => {
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 780 });
    for (const [staff, role] of [["j.masri", "owner"], ["m.costa", "teller"]] as const) {
      await atDesk(page, staff);
      const spelled = await page.evaluate(() => {
        const root = window.CDOS || {};
        const fn = root.formatPhoneMoney || (root.Phone && root.Phone.formatMoney);
        return typeof fn === "function" ? fn(10000, "CAD") : "";
      });
      expect(spelled, "shared phone money formatter").toMatch(/10,000(\.00)? CAD/);
      expect(spelled).not.toContain("$");
      await openCompliance(page);
      const shell = page.locator('[data-phone-shell][data-app="compliance"]');
      const home = shell.getByTestId("compliance-phone-home");
      await expect(home).toBeVisible();
      await expect(home).toHaveAttribute("data-state", "ready");
      await expect(shell).toContainText("Compliance");
      await expect(shell).toContainText(spelled);
      await expect(shell).toContainText("financial intelligence unit");
      await expect(home).toContainText("You file");
      await expect(home).toContainText("does not send the report");
      const tile = home.getByTestId("sanctions-screening-tile");
      await expect(tile).toContainText("Not connected");
      await expect(tile).toContainText("No list provider is connected yet");
      expect(await tile.innerText()).not.toMatch(/\d/);
      await expect(home.getByText("Automatic ID checks")).toBeVisible();
      await expect(home.getByRole("button", { name: "Open Clients" })).toBeVisible();
      await expect(page.locator("#phone-fab")).toHaveCount(0);
      await expect(page.locator("#phonebar .phone-tab")).toHaveCount(5);
      const more = page.locator('#phonebar [data-phone-app="more"].is-on .lbl');
      await expect(more).toHaveCSS("color", "rgb(107, 46, 84)");
      const homeText = await shell.innerText();
      expect(homeText).not.toContain("Use the current Canada rules");
      expect(homeText).not.toContain("Change in Settings");
      expect(homeText).not.toMatch(/\$/);
      await page.screenshot({
        path: `test-results/compliance_home_${role}_${width}.png`,
        fullPage: false,
      });
      if (role === "owner" && width === 390) {
        await home.getByRole("button", { name: /Reportable/ }).click();
        await expect(shell.locator("h1")).toHaveText("What you would file");
        await shell.getByRole("button", { name: "Compliance", exact: true }).click();
        await expect(home).toBeVisible();
        await home.getByRole("tab", { name: /aggregation/ }).click();
        await home.getByRole("button", { name: /Possible split deals/ }).click();
        await expect(shell.locator("h1")).toHaveText("Possible split deals");
        await shell.getByRole("button", { name: "Compliance", exact: true }).click();
        await home.getByRole("tab", { name: "Screening" }).click();
        await expect(home.getByRole("button", { name: "Open Clients" })).toBeVisible();
      }
      if (role === "teller") {
        await page.locator('#phonebar [data-phone-app="more"]').click();
        const labels = await page.locator("#phone-more [data-phone-app]").evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-phone-app"))
        );
        expect(labels).toContain("compliance");
        expect(labels).not.toContain("dashboard");
        expect(labels).not.toContain("settings");
        expect(labels).not.toContain("reports");
      }
    }
  }
});

test("a failed filings load offers a retry and no stale zero", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.route("**/api/ledger/report-filings**", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' })
  );
  await openCompliance(page);
  const shell = page.locator('[data-phone-shell][data-app="compliance"]');
  const home = shell.getByTestId("compliance-phone-home");
  await expect(home.getByTestId("compliance-error")).toContainText("Could not load compliance counts");
  const retry = shell.locator(".phone-sticky-btn");
  await expect(retry).toHaveText("Try again");
  const height = await retry.evaluate((el) => getComputedStyle(el).height);
  expect(height).toBe("48px");
  await expect(home.getByText("Not loaded").first()).toBeVisible();
  await expect(home.getByTestId("sanctions-screening-tile")).toHaveCount(0);
  const values = await home.locator(".phone-stat-value").allInnerTexts();
  expect(values).toEqual(["Not loaded", "Not loaded"]);
  await page.screenshot({ path: "test-results/compliance_error_390.png" });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.screenshot({ path: "test-results/compliance_error_360.png" });
});

test("counts stay blank while filings are loading", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await atDesk(page, "j.masri");
  await page.route("**/api/ledger/report-filings**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });
  await openCompliance(page);
  const loading = page.getByTestId("compliance-loading");
  await expect(loading).toBeVisible();
  expect(await loading.innerText()).not.toMatch(/\d/);
  await page.screenshot({ path: "test-results/compliance_loading_390.png" });
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(loading).toBeVisible();
  await page.screenshot({ path: "test-results/compliance_loading_360.png" });
});
