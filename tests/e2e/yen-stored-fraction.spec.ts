/* An older deal left a yen fraction in the drawer. The count, the
   reconcile, and the end-of-day row name that stored figure, and the
   variance is counted minus the whole-unit expected. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import type { Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as { Pool: new (c: { connectionString: string }) => { query: Function; end: () => Promise<void> } };

const WS = "ws-yen-stored-fraction";
const TILL = "till-yen-fraction";
const TENANT = "tnt-yorkfx";
const ENTITY = "le-yorkfx-canada";
const BRANCH = "br-yorkville";

let pool: { query: Function; end: () => Promise<void> };

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [WS, TENANT, ENTITY, BRANCH, TILL],
  );
  for (const [currency, amount] of [["JPY", "489175.85"], ["CAD", "1000.50"]] as const) {
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
     VALUES ('session-yen-fraction',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())
     ON CONFLICT (session_id) DO NOTHING`,
    [TENANT, ENTITY, BRANCH, WS, TILL],
  );
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openTill(page: Page) {
  await signInAtDesk(page, "j.masri");
  await page.locator('#appbar [data-app="till"]').click();
  await expect(page.getByRole("button", { name: /Reconcile & close/i }).first()).toBeVisible({ timeout: 45_000 });
  const switcher = page.locator('xpath=//button[@title="Switch till at this location" and not(ancestor::*[@id="tenantbar"])]');
  await switcher.click();
  await page.getByRole("button", { name: TILL }).click();
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();
  await expect(page.getByText(new RegExp("ledger till\\s+" + TILL)).first()).toBeVisible({ timeout: 20_000 });
}

test("a stored yen fraction is named, a whole cad figure is not, and a real gap still shows", async ({ page }) => {
  await openTill(page);
  await page.getByRole("button", { name: /Reconcile & close/i }).first().click();
  const recon = page.locator("table").filter({ hasText: "Expected" });
  const jpy = recon.locator("tr").filter({ hasText: "JPY" }).first();
  const cad = recon.locator("tr").filter({ hasText: "CAD" }).first();
  await expect(jpy).toContainText("489,176");
  await expect(jpy).toContainText("Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.");
  await expect(cad).toContainText("1,000.50");
  await expect(cad).not.toContainText("Rounded from");

  await jpy.getByRole("button", { name: /count/i }).click();
  await page.getByRole("button", { name: /^Enter total$/ }).click();
  const total = page.locator('input[type="number"]');
  await total.fill("489176");
  await page.locator(".till-expected").click();
  const whole = page.locator(".till-count-foot");
  await expect(whole).toContainText("489,176");
  await expect(whole).toContainText("balanced");
  await expect(whole).not.toContainText("0.15");

  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  await expect(jpy).toContainText("balanced");
  await expect(jpy).not.toContainText("0.15");
  await page.setViewportSize({ width: 390, height: 780 });
  const reconFit = await recon.evaluate((table) => {
    const card = table.closest(".till-recon");
    const edge = card ? card.getBoundingClientRect().right : 0;
    const headers = Array.from(table.querySelectorAll("thead th")).map((th) => ({
      text: (th.textContent || "").trim(),
      right: th.getBoundingClientRect().right,
    }));
    return { edge, headers };
  });
  for (const label of ["Expected", "Variance"]) {
    const header = reconFit.headers.find((h) => h.text.includes(label));
    expect(header, label).toBeTruthy();
    expect(header!.right).toBeLessThanOrEqual(reconFit.edge + 1);
  }
  await page.setViewportSize({ width: 1280, height: 780 });

  await page.locator(".fld-tab", { hasText: "Cash drawer" }).evaluate((el: HTMLElement) => el.click());
  await total.fill("489177");
  await page.locator(".till-expected").click();
  const foot = page.locator(".till-count-foot");
  await expect(foot).toContainText("489,176");
  await expect(foot).toContainText("+1 over");
  await expect(foot).toContainText("Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.");
  const expectedLine = foot.locator(".till-expected");
  await expect(expectedLine).toContainText("≈");
  const approxFollowsNote = await foot.evaluate((el) => {
    const note = el.querySelector(".till-stored-note");
    if (!note || !note.parentElement) return false;
    let n: ChildNode | null = note.nextSibling;
    while (n) {
      if ((n.textContent || "").includes("≈")) return true;
      n = n.nextSibling;
    }
    return false;
  });
  expect(approxFollowsNote).toBe(false);

  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  await expect(jpy).toContainText("+1");
  await expect(jpy).toContainText("Rounded from 489,175.85 JPY");

  await page.locator('#appbar [data-app="reports"]').evaluate((el: HTMLElement) => el.click());
  await page.getByText("End-of-Day Sign-Off").first().click();
  const eodTable = page.locator("table").filter({ hasText: "In the drawer" });
  const eod = eodTable.locator("tr", { hasText: "JPY" }).first();
  await expect(eod).toContainText("489,176");
  await expect(eod).not.toContainText("Rounded from");
  const noteRow = eod.locator("xpath=following-sibling::tr[1]");
  await expect(noteRow).toContainText("Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.");

  const figure = noteRow.locator(".till-stored-figure");
  await expect(figure).toBeVisible();
  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 780 });
    const proof = await figure.evaluate((el) => {
      const texts = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").length > 0);
      const range = document.createRange();
      range.selectNodeContents(el);
      const cell = el.closest("td");
      const table = el.closest("table");
      const cols = table ? table.querySelectorAll("thead th").length : 0;
      return {
        textNodes: texts.length,
        text: texts.map((n) => n.textContent || "").join(""),
        rects: range.getClientRects().length,
        whiteSpace: getComputedStyle(el).whiteSpace,
        colspan: cell ? cell.getAttribute("colspan") : "",
        cols,
        cellWidth: cell ? Math.round(cell.getBoundingClientRect().width) : 0,
        tableWidth: table ? Math.round(table.getBoundingClientRect().width) : 0,
      };
    });
    expect(proof.textNodes).toBe(1);
    expect(proof.text).toBe("489,175.85");
    expect(proof.rects).toBe(1);
    expect(proof.whiteSpace).toBe("nowrap");
    expect(proof.colspan).toBe(String(proof.cols));
    expect(proof.cols).toBe(6);
    expect(proof.cellWidth).toBe(proof.tableWidth);
    expect(proof.cellWidth).toBeGreaterThan(200);
  }
});
