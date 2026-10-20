/* A count saved before stored_expected_amount existed keeps its
   variance. 100 against 99.85 yen was saved as 0.15. The sign-off
   shows that saved figure, and so does the CSV. Recomputing the
   whole-unit difference would say balanced. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (c: { connectionString: string }) => { query: Function; end: () => Promise<void> };
};

const WS = "ws-stored-variance";
const TILL = "till-stored-variance";
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
    `INSERT INTO ledger_till_balances
      (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount)
     VALUES ($1,$2,$3,$4,$5,'JPY',99.85)
     ON CONFLICT (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency)
     DO UPDATE SET available_amount = EXCLUDED.available_amount`,
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-stored-variance',$1,$2,$3,$4,$5,1,current_date,'open',$1||':j.masri',now())
     ON CONFLICT (session_id) DO NOTHING`,
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_till_count_batches
      (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
       till_id,count_kind,actor_id,idempotency_key,counted_at)
     VALUES ('batch-stored-variance','session-stored-variance',$1,$2,$3,$4,$5,
             'interim',$1||':j.masri','legacy-yen',now())
     ON CONFLICT DO NOTHING`,
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_till_counts
      (batch_id,currency,expected_amount,counted_amount,variance_amount,stored_expected_amount)
     VALUES ('batch-stored-variance','JPY',99.85,100.00,0.15,NULL)
     ON CONFLICT DO NOTHING`,
  );
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openSignOff(page: Page) {
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
  await page.getByText("End-of-Day Sign-Off").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
}

test("an old yen count shows the variance that was saved", async ({ page }) => {
  await openSignOff(page);
  const table = page.locator("table").filter({ hasText: "In the drawer" });
  const jpy = table.locator("tr", { hasText: "JPY" }).first();
  await expect(jpy).toContainText("99.85");
  await expect(jpy).toContainText("+0.15");
  await expect(jpy).not.toContainText("balanced");
  const note = jpy.locator("xpath=following-sibling::tr[1]");
  await expect(note).toContainText("Counted before whole-yen display. Variance shown as saved then.");
  const total = table.locator("tr", { hasText: "Total" });
  await expect(total).not.toContainText("balanced");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const download = await downloadPromise;
  const csv = readFileSync(await download.path(), "utf8");
  const line = csv.split(/\r?\n/).find((row) => row.split(",").some((cell) => cell.replace(/"/g, "") === "JPY"));
  expect(line, csv).toBeTruthy();
  const cells = line!.split(",").map((cell) => cell.replace(/^"|"$/g, ""));
  expect(cells[4]).toBe("0.15");

  const saved = await pool.query(
    `SELECT variance_amount::text AS variance, stored_expected_amount
       FROM ledger_till_counts WHERE batch_id = 'batch-stored-variance'`,
  );
  expect(saved.rows[0].stored_expected_amount).toBeNull();
  expect(saved.rows[0].variance).toBe("0.15");
  expect(cells[4]).toBe(saved.rows[0].variance);
});
