/* Cash drawer movement is the book's figure. Two stored payouts of
   100.40 yen read Paid out 200 on an open day. A summary the desk
   cannot read says the ledger has no answer, and does not print the
   browser's own sum of those rows. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

function channel(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrastOf(fg: string, bg: string) {
  const read = (color: string) => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) throw new Error(color);
    const [r, g, b, a] = match[1].split(",").map((part) => Number(part.trim()));
    return { r, g, b, a: a == null ? 1 : a };
  };
  const back = read(bg);
  const front = read(fg);
  const over = front.a < 1
    ? {
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
      }
    : front;
  const lum = (rgb: { r: number; g: number; b: number }) =>
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  const light = Math.max(lum(over), lum(back));
  const dark = Math.min(lum(over), lum(back));
  return (light + 0.05) / (dark + 0.05);
}

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
  const table = page.locator("#cdos-report-doc .drawer-movement table");
  const row = table.locator("tr", { hasText: "JPY" });
  await expect(row).toBeVisible({ timeout: 20_000 });
  const text = await row.innerText();
  expect(text).not.toContain("200.8");
  expect(text).not.toContain("200.80");
  const cells = row.locator("td");
  await expect(cells.nth(1)).toHaveText("0");
  await expect(cells.nth(2)).toHaveText("200");
  await expect(cells.nth(3)).toHaveText("-200");
  const cad = table.locator("tr", { hasText: "CAD" });
  await expect(cad.locator("td").nth(1)).toHaveText("200.00");
  await expect(cad.locator("td").nth(2)).toHaveText("0.00");
  await expect(cad.locator("td").nth(3)).toHaveText("+200.00");
  await expect(table.locator("thead th").nth(1)).toHaveText("In");
  await expect(table.locator("thead th").nth(2)).toHaveText("Out");
  await expect(table.locator("thead th").nth(3)).toHaveText("Net");
  const caption = page.locator(".drawer-movement-caption");
  await expect(caption).toHaveText("In is cash received. Out is cash paid out. Net is in minus out.");
  const ink = await caption.evaluate((el) => {
    const fg = getComputedStyle(el).color;
    let node: HTMLElement | null = el as HTMLElement;
    let bg = "rgb(255, 255, 255)";
    while (node) {
      const painted = getComputedStyle(node).backgroundColor;
      if (painted && painted !== "rgba(0, 0, 0, 0)" && painted !== "transparent") {
        bg = painted;
        break;
      }
      node = node.parentElement;
    }
    return { fg, bg };
  });
  expect(contrastOf(ink.fg, ink.bg), JSON.stringify(ink)).toBeGreaterThanOrEqual(4.5);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.locator(".drawer-movement").scrollIntoViewIfNeeded();
  const fit = await page.locator(".drawer-movement").evaluate((card) => {
    const box = card.getBoundingClientRect();
    const headers = Array.from(card.querySelectorAll("thead th")).map((th) => {
      const range = document.createRange();
      range.selectNodeContents(th);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      const right = rects.reduce((max, r) => Math.max(max, r.right), 0);
      const left = rects.reduce((min, r) => Math.min(min, r.left), box.right);
      return { text: (th.textContent || "").trim(), left, right };
    });
    return { edge: box.right, view: window.innerWidth, headers };
  });
  for (const label of ["In", "Out", "Net"]) {
    const header = fit.headers.find((h) => h.text === label);
    expect(header, label).toBeTruthy();
    expect(header!.right, label).toBeLessThanOrEqual(fit.edge + 1);
    expect(header!.right, label).toBeLessThanOrEqual(fit.view + 1);
    expect(header!.left, label).toBeGreaterThanOrEqual(0);
  }
});
