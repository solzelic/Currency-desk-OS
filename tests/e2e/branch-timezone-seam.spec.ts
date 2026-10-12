/* The Settings time zone is the server's value.

   Saving it and reloading the desk shows what branches.timezone
   holds. A control that only wrote localStorage would look saved
   and come back as America/Toronto. */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { timezone: string }[] }>;
    end: () => Promise<void>;
  };
};

const BRANCH = "br-yorkville";
let original: string | null = null;

test.beforeAll(async () => {
  if (!hasLedger) return;
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const found = await pool.query("SELECT timezone FROM branches WHERE id=$1", [BRANCH]);
  original = found.rows[0]?.timezone ?? null;
  if (!original) throw new Error("br-yorkville has no time zone");
  await pool.end();
});

test.afterAll(async () => {
  if (!hasLedger || !original) return;
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await pool.query("UPDATE branches SET timezone=$2 WHERE id=$1", [BRANCH, original]);
  await pool.end();
});

async function dismissTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible()) await skip.click();
}

async function openTimezone(page: Page) {
  const width = page.viewportSize()?.width ?? 1280;
  if (width <= 430) {
    const sheet = page.locator("#phone-more");
    if (!(await sheet.isVisible())) {
      await page.locator('#phonebar [data-phone-app="more"]').click();
    }
    await page.locator('#phone-more [data-phone-app="settings"]').click();
  } else {
    await page.getByText(/^Settings$/i).first().click();
  }
  await dismissTour(page);
  /* The nav label's text node is " Localization" — a space after the
     icon. A regex anchored to the whole string never matches that,
     so the click waits until the test times out on a screen where
     the word is plainly visible. The button's accessible name is
     the word itself. */
  await page.locator(".settings-nav").getByRole("button", { name: "Localization" }).click();
  await page.getByTestId("branch-timezone").waitFor({ timeout: 20_000 });
}

test("saving the time zone and reloading shows the server value", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAtDesk(page, "j.masri");
  await dismissTour(page);
  await openTimezone(page);
  await expect(page.getByText("Applies from the next time a till is opened.")).toBeVisible();

  const shots = process.env.TIMEZONE_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    const row = page.getByTestId("settings-timezone");
    await row.scrollIntoViewIfNeeded();
    await row.screenshot({
      path: path.join(shots, "settings-timezone-1280.png"),
    });
  }

  const before = await page.evaluate(() =>
    fetch("/api/ledger/branch-timezone", { credentials: "same-origin" }).then((r) => r.json()),
  );
  const next = before.timezone === "Europe/London" ? "America/Vancouver" : "Europe/London";
  await page.getByTestId("branch-timezone").selectOption(next);
  await expect
    .poll(async () => {
      const body = await page.evaluate(() =>
        fetch("/api/ledger/branch-timezone", { credentials: "same-origin" }).then((r) => r.json()),
      );
      return body.timezone as string;
    }, { timeout: 15_000 })
    .toBe(next);

  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await openTimezone(page);
  await expect(page.getByTestId("branch-timezone")).toHaveValue(next);
  await expect(page.getByText("Applies from the next time a till is opened.")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await landOnDesktop(page);
  await dismissTour(page);
  await openTimezone(page);
  await expect(page.getByTestId("branch-timezone")).toHaveValue(next);
  await expect(page.getByText("Applies from the next time a till is opened.")).toBeVisible();
  if (shots) {
    await page.getByTestId("settings-timezone").scrollIntoViewIfNeeded();
    await page.getByTestId("settings-timezone").screenshot({
      path: path.join(shots, "settings-timezone-390.png"),
    });
  }
});
