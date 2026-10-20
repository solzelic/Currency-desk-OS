/* Cash drawer movement is the book's figure. Two stored payouts of
   100.40 yen read Paid out 200 on an open day. A summary the desk
   cannot read says the ledger has no answer, and does not print the
   browser's own sum of those rows. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => { query: Function; end: () => Promise<void> };
};

const WS = "ws-drawer-book";
const TILL = "till-drawer-book";
const TENANT = "tnt-yorkfx";
const ENTITY = "le-yorkfx-canada";
const BRANCH = "br-yorkville";
const scope = [TENANT, ENTITY, BRANCH, WS, TILL];

let pool: { query: Function; end: () => Promise<void> };

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [WS, TENANT, ENTITY, BRANCH, TILL],
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-drawer-book',$1,$2,$3,$4,$5,1,current_date,'open',$1||':j.masri',now())
     ON CONFLICT (session_id) DO NOTHING`,
    scope,
  );
  const insert = (id: string) => pool.query(
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
    [id, `ref-${id}`, ...scope],
  );
  await insert("drawer-jpy-a");
  await insert("drawer-jpy-b");
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openSummary(page: Page) {
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="till"]').click();
  const switcher = page.locator('xpath=//button[@title="Switch till at this location" and not(ancestor::*[@id="tenantbar"])]');
  await switcher.click();
  await page.getByRole("button", { name: TILL }).click();
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();
  await expect(page.getByText(new RegExp("ledger till\\s+" + TILL)).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("Period Summary").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
}

test("an unread book says so, and a read book shows the rounded drawer", async ({ page }) => {
  await page.route("**/api/ledger/summary**", (route) => route.abort());
  await openSummary(page);
  const missedDrawer = page.locator("#cdos-report-doc .drawer-movement");
  await expect(missedDrawer).toContainText("The ledger has no answer");
  await expect(missedDrawer).not.toContainText("200.8");
  await page.unroute("**/api/ledger/summary**");

  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="till"]').click();
  await expect(page.getByText(new RegExp("ledger till\\s+" + TILL)).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("Period Summary").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
  const table = page.locator("#cdos-report-doc table").filter({ hasText: "Paid out" });
  const row = table.locator("tr", { hasText: "JPY" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const text = await row.innerText();
  expect(text).not.toContain("200.8");
  expect(text).not.toContain("200.80");
  expect(text).toMatch(/200(?!\.\d)/);
});
