/* The till banner was counting currencies as drawers, the count clock
   was 24-hour in the browser zone, and a few till and end-of-day
   sentences still used an em dash. The Counted column keeps the
   currency's places: CAD and USD keep two, yen stays whole. */
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => { query: Function; end: () => Promise<void> };
};

const TENANT = "tnt-yorkfx";
const ENTITY = "le-yorkfx-canada";
const BRANCH = "br-yorkville";
const WS = "ws-yen-followup";
const TILL = "till-yen-followup";
const QUIET = "till-yen-quiet";
const QUIET_WS = "ws-yen-quiet";
const ROUND = "till-yen-round";
const ROUND_WS = "ws-yen-round";
/* 20:30 UTC is 4:30 pm in Toronto while daylight saving holds, and
   8:30 pm if the clock is left on UTC. */
const COUNTED_AT = "2026-10-21T20:30:00.000Z";
const SHOTS = "/opt/cursor/artifacts/yen-followup";
const REPO_SHOTS = path.join(process.cwd(), "docs/pr-shots/yen-followup");

let pool: { query: Function; end: () => Promise<void> };

async function workspace(id: string, till: string) {
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [id, TENANT, ENTITY, BRANCH, till],
  );
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await workspace(WS, TILL);
  await workspace(QUIET_WS, QUIET);
  await workspace(ROUND_WS, ROUND);
  for (const [currency, amount] of [
    ["CAD", "20000.00"],
    ["USD", "5000.00"],
    ["JPY", "489175.85"],
    ["PHP", "100.00"],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_till_balances
        (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency)
       DO UPDATE SET available_amount = EXCLUDED.available_amount`,
      [TENANT, ENTITY, BRANCH, WS, TILL, currency, amount],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-yen-followup',$1,$2,$3,$4,$5,1,
             timezone('America/Toronto', now())::date,'open',$1||':j.masri',now())
     ON CONFLICT (session_id) DO NOTHING`,
    [TENANT, ENTITY, BRANCH, WS, TILL],
  );
  await pool.query(
    `INSERT INTO ledger_till_count_batches
      (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
       till_id,count_kind,actor_id,idempotency_key,counted_at)
     VALUES ('yen-followup-batch','session-yen-followup',$1,$2,$3,$4,$5,
             'interim',$1||':j.masri','yen-followup-batch',$6)
     ON CONFLICT (batch_id) DO NOTHING`,
    [TENANT, ENTITY, BRANCH, WS, TILL, COUNTED_AT],
  );
  for (const [currency, expected, counted, variance] of [
    ["CAD", "20000.00", "20000.00", "0.00"],
    ["USD", "5000.00", "5000.00", "0.00"],
    ["JPY", "489175.85", "489177.00", "1.00"],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_till_counts
        (batch_id,currency,expected_amount,counted_amount,variance_amount)
       VALUES ('yen-followup-batch',$1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [currency, expected, counted, variance],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-yen-round',$1,$2,$3,$4,$5,1,
             timezone('America/Toronto', now())::date,'open',$1||':j.masri',now())
     ON CONFLICT (session_id) DO NOTHING`,
    [TENANT, ENTITY, BRANCH, ROUND_WS, ROUND],
  );
  const book = [TENANT, ENTITY, BRANCH, ROUND_WS, ROUND];
  for (const suffix of ["a", "b"]) {
    const id = `yen-round-${suffix}`;
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
          workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
          input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
          source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
          jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, 'customer-demo', $3||':j.masri',
          'CAD', 'JPY', 100.00, 100.40, 1, 0, 0, 'travel', 'salary', now(),
          'exchange', 'cash', 'cash', 'pack-ca-v1', 1, 'CAD')
       ON CONFLICT (transaction_id) DO NOTHING`,
      [id, `ref-${id}`, ...book],
    );
  }
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function skipTour(page: Page) {
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

async function switchTill(page: Page, till: string) {
  const switcher = page.locator('xpath=//button[@title="Switch till at this location" and not(ancestor::*[@id="tenantbar"])]');
  await switcher.click();
  /* The branch menu is taller than the window, and the extra tills sit
     under the fold. The row is in the document. Click it there. */
  await page.evaluate((name) => {
    const hit = Array.from(document.querySelectorAll("button")).find((button) =>
      (button.textContent || "").trim().startsWith(name),
    );
    if (!hit) throw new Error("no till row " + name);
    hit.click();
  }, till);
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();
  await expect(page.getByText(new RegExp("ledger till\\s+" + till)).first()).toBeVisible({ timeout: 20_000 });
}

async function openDrawer(page: Page, till: string) {
  await signInAtDesk(page, "j.masri");
  await skipTour(page);
  await page.locator('#appbar [data-app="till"]').click();
  await expect(page.getByRole("button", { name: /Reconcile & close/i }).first()).toBeVisible({ timeout: 45_000 });
  await switchTill(page, till);
}

function noDash(text: string) {
  expect(text).not.toContain("\u2014");
  expect(text).not.toContain("\u2013");
}

async function sheetCell(page: Page, ccy: string, header: string) {
  const table = page.locator("table").filter({ hasText: "In the drawer" });
  const headers = await table.locator("thead th").evaluateAll((ths) =>
    ths.map((th) => (th.textContent || "").trim()),
  );
  const index = headers.indexOf(header);
  expect(index).toBeGreaterThan(0);
  return table.locator("tbody tr", { hasText: ccy }).first().locator("td").nth(index);
}

test("one till counts as one drawer and the count clock is branch 12-hour", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDrawer(page, TILL);
  const banner = page.locator(".till-statusline").first();
  await expect(banner).toContainText("1 till counted");
  await expect(banner).not.toContainText("drawer counted");
  noDash((await banner.textContent()) || "");
  const when = page.locator(".till-counted-when");
  await expect(when).toContainText("4:30 pm");
  await expect(when).not.toContainText("20:30");
  await expect(when).not.toContainText("16:30");
  const session = page.locator(".till-sessionline").first();
  const sessionText = (await session.textContent()) || "";
  expect(sessionText).toMatch(/opened by .+ at \d{1,2}:\d{2} (am|pm)/);
  expect(sessionText).not.toMatch(/[ap]\.m\./);
  const since = page.locator(".till-operator").first();
  await expect(since).toContainText(/since \d{1,2}:\d{2} (am|pm)/);
  noDash((await since.textContent()) || "");
  const expected = page.locator(".till-expected").first();
  await expect(expected).toHaveAttribute("title", "Show the expected amount.");
  await expected.click();
  await expect(expected).toHaveAttribute("title", "Hide expected. Keep the count blind.");
  noDash((await expected.getAttribute("title")) || "");
});

test("a till with no session names that without an em dash", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDrawer(page, QUIET);
  const banner = page.locator(".till-statusline").first();
  await expect(banner).toContainText("Session not opened");
  noDash((await banner.textContent()) || "");
  const nobody = page.getByText("Nobody is on this till. No session is open.");
  await expect(nobody).toHaveText("Nobody is on this till. No session is open.");
  noDash((await nobody.textContent()) || "");
});

test("two yen rows of 100.40 read 200 out on an open day", async ({ page }) => {
  await openDrawer(page, ROUND);
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("Period Summary").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
  const row = page.locator("#cdos-report-doc .drawer-movement table tr", { hasText: "JPY" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const text = await row.innerText();
  expect(text).not.toContain("200.8");
  expect(text).not.toContain("200.80");
  expect(text).not.toContain("201");
  await expect(row.locator("td").nth(2)).toHaveText("200");
});

test("the close review keeps CAD cents", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openDrawer(page, TILL);
  await page.getByRole("button", { name: "Cash drawer" }).click();
  await page.locator(".till-chip", { hasText: "PHP" }).click();
  await page.getByRole("button", { name: "Enter total" }).click();
  await page.locator(".till-counted input").fill("100");
  await page.locator("[data-tour='till-reconcile-tab']").evaluate((node) => (node as HTMLButtonElement).click());
  const close = page.getByRole("button", { name: "Close day and lock book" });
  await expect(close).toBeEnabled({ timeout: 20_000 });
  await close.click();
  const table = page.locator("table").filter({ hasText: "Last counted" });
  const cad = table.locator("tr", { hasText: "CAD" });
  await expect(cad.locator("td").nth(1)).toHaveText("20,000.00");
  await expect(cad.locator("td").nth(2)).toHaveText("20,000.00");
  await expect(table).not.toContainText("\u2014 not counted");
  await expect(table.getByText("Not counted.")).toHaveCount(0);
});

test("the 1280 Counted column keeps each currency's places", async ({ page }, testInfo) => {
  await openDrawer(page, TILL);
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("End-of-Day Sign-Off").first().click();
  const doc = page.locator("#cdos-report-doc");
  await doc.waitFor({ state: "visible", timeout: 30_000 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(await sheetCell(page, "CAD", "Counted")).toHaveText("20,000.00");
  await expect(await sheetCell(page, "USD", "Counted")).toHaveText("5,000.00");
  await expect(await sheetCell(page, "JPY", "Counted")).toHaveText("489,177");
  const php = await sheetCell(page, "PHP", "Counted");
  await expect(php).toHaveText("Not counted.");
  noDash((await php.textContent()) || "");
  const variance = await sheetCell(page, "PHP", "Variance");
  await expect(variance).toHaveText("No variance.");
  noDash((await variance.textContent()) || "");
  const safe = await sheetCell(page, "CAD", "In the safe");
  await expect(safe).toHaveText("Not in the safe.");
  noDash((await safe.textContent()) || "");

  expect(await page.evaluate(() => (window as any).CDOS.copy.notInTill)).toBe("Not in this till.");
  await expect(doc).not.toContainText("Not in this drawer.");
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(REPO_SHOTS, { recursive: true });
  await page.locator('#appbar [data-app="till"]').click();
  await expect(page.locator(".till-counted-when")).toContainText("4:30 pm");
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    await page.locator("[data-tour='till']").scrollIntoViewIfNeeded();
    const tillName = `till_${width}.png`;
    const tillShot = `${SHOTS}/${tillName}`;
    await page.screenshot({ path: tillShot });
    copyFileSync(tillShot, path.join(REPO_SHOTS, tillName));
    await testInfo.attach(`till-${width}`, { path: tillShot, contentType: "image/png" });
  }
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("End-of-Day Sign-Off").first().click();
  await doc.waitFor({ state: "visible", timeout: 30_000 });
  for (const width of [360, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: width >= 1280 ? 800 : 844 });
    const table = page.locator("table").filter({ hasText: "In the drawer" });
    await table.scrollIntoViewIfNeeded();
    const eodName = `eod_counted_${width}.png`;
    const eodShot = `${SHOTS}/${eodName}`;
    await page.screenshot({ path: eodShot });
    copyFileSync(eodShot, path.join(REPO_SHOTS, eodName));
    await testInfo.attach(`eod-${width}`, { path: eodShot, contentType: "image/png" });
  }
});
