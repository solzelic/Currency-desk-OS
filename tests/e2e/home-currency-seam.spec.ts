/* The owner changes the base currency from Settings, on the screen.

   The confirm step is the server's own sentences. After the save, the
   compliance line, Transfers, and the rate board follow the new currency.
   The published board comes off the counter instead of being relabelled. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, landOnDesktop, codeFor, logSize } from "./fixtures";
import type { Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
    end: () => Promise<void>;
  };
};

const stamp = Date.now();
const EMAIL = `owner-${stamp}@home-currency-seam.example`;
const SHOP = `Home Currency ${stamp}`;
const SLUG = `hcur${stamp}`;
const SNAP = `snap-home-seam-${stamp}`;
const MIDS = { USD: 1.36, GBP: 1.7, EUR: 1.5 };
const shots = "/opt/cursor/artifacts/screenshots";

let pool: InstanceType<typeof Pool>;

test.beforeAll(async () => {
  if (!hasLedger) return;
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
});

test.afterAll(async () => {
  if (!pool) return;
  await pool.end();
});

async function openLocalization(page: Page) {
  await page.getByText(/^Settings$/i).first().click();
  await page.locator('div[style*="width: 212px"], .settings-nav').getByText(/^Localization$/i).first().click();
  await page.getByTestId("home-currency").waitFor();
}

test("the owner reviews the change, confirms it, and the desk follows GBP", async ({ page }) => {
  await pool.query(
    `INSERT INTO market_rates (id, provider, mids, fetched_at)
     VALUES ($1, 'test', $2::jsonb, now())`,
    [SNAP, JSON.stringify(MIDS)],
  );

  const before = logSize();
  const started = await page.request.post("/api/signup", {
    data: {
      businessName: SHOP,
      ownerName: "Home Owner",
      email: EMAIL,
      password: "baseline-desk-2026",
      slug: SLUG,
      onboarding: { country: "Serbia", homeCurrency: "USD", city: "Belgrade", plan: "full" },
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const code = await codeFor(EMAIL, before);
  const verified = await page.request.post("/api/signup/verify", { data: { email: EMAIL, code } });
  expect(verified.status(), await verified.text()).toBe(201);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app");
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible({ timeout: 3_000 }).catch(() => false)) await skip.click();

  await openLocalization(page);
  const panel = page.getByTestId("home-currency");
  await expect(panel.getByTestId("home-currency-current")).toHaveText("USD");
  await panel.getByTestId("home-currency-select").selectOption("GBP");
  const confirm = page.getByTestId("home-currency-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("The desk keeps its books in GBP");
  await expect(confirm).toContainText("Nothing already written is rewritten");
  await expect(confirm).toContainText("comes off the counter");
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-confirm-1280.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  const maximized = page.locator(".win.active.win.max");
  if ((await maximized.count()) === 0) await page.locator(".win.active .win-zoom").click();
  await confirm.scrollIntoViewIfNeeded();
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-confirm-390.png` });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("home-currency-password").fill("baseline-desk-2026");
  await page.getByTestId("home-currency-submit").click();
  await expect(page.getByTestId("home-currency-done")).toContainText("GBP");
  await expect(page.getByTestId("home-currency-current")).toHaveText("GBP");
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-done-1280.png` });

  await page.locator(".settings-nav, div[style*='width: 212px']").getByText(/Compliance & jurisdiction/i).first().click();
  await expect(page.getByTestId("compliance-jurisdiction")).toContainText("£8,000.00");
  await expect(page.getByTestId("compliance-jurisdiction")).toContainText("£2,400.00");

  await page.getByText(/^Transfers$/i).first().click();
  await expect(page.getByText("Customer pays in (GBP)")).toBeVisible();

  await page.getByText(/^Rate Board$/i).first().click();
  const notice = page.getByTestId("rate-board-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("priced in USD");
  await expect(notice).toContainText("GBP");

  const tape = await page.request.get("/api/rates/ticker");
  expect(tape.ok()).toBe(true);
  expect((await tape.json()).home).toBe("GBP");
  const board = await page.request.get("/api/rates");
  expect((await board.json()).board).toBeNull();
});
