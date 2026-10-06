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

/* The first-run card is not a scrim, but it does keep moving while it
   looks for a gap, and a Playwright click waits for that button to sit
   still. Skip from the page instead, and tell the tour not to start
   again when the staff id arrives a moment later. */
async function dismissTour(page: Page) {
  await page.evaluate(() => {
    const tour = (window as unknown as { CDOS_TOUR?: { shouldShow: () => boolean } }).CDOS_TOUR;
    if (tour) tour.shouldShow = () => false;
  });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if ((await page.locator(".cdos-tour").count()) === 0) {
      await page.waitForTimeout(400);
      if ((await page.locator(".cdos-tour").count()) === 0) return;
    }
    await page.evaluate(() => {
      const tour = (window as unknown as { CDOS_TOUR?: { shouldShow: () => boolean } }).CDOS_TOUR;
      if (tour) tour.shouldShow = () => false;
      const btn = document.querySelector(".cdos-tour-skip");
      if (btn instanceof HTMLButtonElement) btn.click();
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }
}

async function openLocalization(page: Page) {
  await dismissTour(page);
  /* The dock's Settings label is the last icon and sits under the
     right-edge rail once the bar scrolls. The menu-bar gear is the
     same openApp('settings') and stays on screen. */
  const gear = page.locator('button.mb-op[title="Settings"]');
  if (await gear.isVisible().catch(() => false)) await gear.click();
  else {
    await page.evaluate(() => {
      const el = document.querySelector('#appbar [data-app="settings"]');
      if (el instanceof HTMLElement) el.click();
    });
  }
  const nav = page.locator(".settings-nav").last();
  await nav.waitFor({ state: "visible" });
  /* A Playwright click on this row waits out the whole test when the
     window is still settling its entrance. The row is a real button;
     clicking it from the page is the same handler. */
  const opened = await page.evaluate(() => {
    const navs = document.querySelectorAll(".settings-nav");
    const rail = navs[navs.length - 1];
    if (!rail) return "no settings nav";
    const btn = [...rail.querySelectorAll("button")].find((b) => /Localization/.test(b.textContent || ""));
    if (!(btn instanceof HTMLButtonElement)) return rail.textContent || "localization missing";
    btn.click();
    return "ok";
  });
  if (opened !== "ok") throw new Error(opened);
  await page.getByTestId("home-currency-select").waitFor();
}

async function openDockApp(page: Page, id: string) {
  await page.evaluate((app) => {
    const el = document.querySelector(`#appbar [data-app="${app}"]`);
    if (el instanceof HTMLElement) el.click();
  }, id);
}

test("the owner reviews the change, confirms it, and the desk follows GBP", async ({ page }) => {
  test.setTimeout(120_000);
  await pool.query(
    `INSERT INTO enquiries (id, reference, kind, email, name, status)
     VALUES ($1, $2, 'early_access', $3, $4, 'invited')`,
    [`enq-${stamp}`, `CD-H${String(stamp).slice(-6)}`, EMAIL, "Home Owner"],
  );
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
  await openLocalization(page);
  const panel = page.getByTestId("home-currency");
  await expect(panel.getByTestId("home-currency-current")).toHaveText("USD");
  await panel.getByTestId("home-currency-select").selectOption("GBP");
  const confirm = page.getByTestId("home-currency-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("The desk keeps its books in GBP");
  await expect(confirm).toContainText("1 USD = 0.8000 GBP");
  await expect(confirm).toContainText("Nothing already written is rewritten");
  await expect(confirm).toContainText("comes off the counter");
  await expect(confirm.getByTestId("home-currency-rate-at")).toContainText("That market rate was fetched");
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-confirm-1280.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  const maximized = page.locator(".win.active.win.max");
  if ((await maximized.count()) === 0) await page.locator(".win.active .win-zoom").click();
  const box = await confirm.boundingBox();
  expect(box, "confirm box is in the layout").toBeTruthy();
  expect(box!.y).toBeLessThan(844 / 2);
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-confirm-390.png` });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("home-currency-password").fill("baseline-desk-2026");
  await page.getByTestId("home-currency-submit").click();
  await expect(page.getByTestId("home-currency-done")).toContainText("GBP");
  await expect(page.getByTestId("home-currency-current")).toHaveText("GBP");
  await page.locator(".win.active").screenshot({ path: `${shots}/home-currency-done-1280.png` });

  const compliance = await page.evaluate(() => {
    const rail = document.querySelector(".settings-nav");
    const btn = rail && [...rail.querySelectorAll("button")].find((b) => /Compliance & jurisdiction/.test(b.textContent || ""));
    if (!(btn instanceof HTMLButtonElement)) return "compliance tab missing";
    btn.click();
    return "ok";
  });
  if (compliance !== "ok") throw new Error(compliance);
  await expect(page.getByTestId("compliance-jurisdiction")).toContainText("£8,000.00");
  await expect(page.getByTestId("compliance-jurisdiction")).toContainText("£2,400.00");

  await openDockApp(page, "transfers");
  /* The pipeline and the header each have this button. Either opens the form. */
  await page.locator(".win.active").getByRole("button", { name: /^New transfer$/ }).first().click();
  await expect(page.getByText("Customer pays in (GBP)")).toBeVisible();

  await openDockApp(page, "rates");
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
