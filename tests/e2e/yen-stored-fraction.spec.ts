/* An older deal left a yen fraction in the drawer. The count, the
   reconcile, and the end-of-day row name that stored figure, and the
   variance is counted minus the whole-unit expected. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Locator, Page } from "@playwright/test";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL. The embedded database has no ledger");

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

async function panelContrast(target: Locator) {
  const ink = await target.evaluate((el) => {
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
  return { ink, ratio: contrastOf(ink.fg, ink.bg) };
}

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
     VALUES ('session-yen-fraction',$1,$2,$3,$4,$5,1,current_date,'open',$1||':j.masri',now())
     ON CONFLICT (session_id) DO NOTHING`,
    [TENANT, ENTITY, BRANCH, WS, TILL],
  );
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openTill(page: Page) {
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
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
  await expect(jpy).not.toContainText("Rounded from");
  const openingNote = jpy.locator("xpath=following-sibling::tr[1]");
  await expect(openingNote).toContainText("Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.");
  await expect(cad).toContainText("1,000.50");
  await expect(cad).not.toContainText("Rounded from");

  await jpy.getByRole("button", { name: /count/i }).evaluate((el: HTMLElement) => el.click());
  await page.getByRole("button", { name: /^Enter total$/ }).click();
  const total = page.locator('input[type="number"]');
  await total.fill("489176");
  await page.locator(".till-expected").evaluate((el: HTMLElement) => el.click());
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
  await page.locator(".till-expected").evaluate((el: HTMLElement) => el.click());
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
  const countInk = await panelContrast(foot.locator(".till-stored-note"));
  expect(countInk.ratio, "count stored line " + JSON.stringify(countInk.ink)).toBeGreaterThanOrEqual(4.5);

  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  await expect(jpy).toContainText("+1");
  await expect(jpy).not.toContainText("Rounded from");
  await page.setViewportSize({ width: 360, height: 780 });
  await jpy.scrollIntoViewIfNeeded();
  const reconSpan = await jpy.evaluate((row) => {
    const cells = Array.from(row.querySelectorAll("td"));
    const expected = cells[2];
    const next = row.nextElementSibling;
    const note = next ? next.querySelector(".till-stored-note") : null;
    const cell = note ? note.closest("td") : null;
    const table = row.closest("table");
    const rowBox = row.getBoundingClientRect();
    const tableBox = table ? table.getBoundingClientRect() : { width: 0 };
    const cellBox = cell ? cell.getBoundingClientRect() : { width: 0 };
    return {
      noteInsideExpected: !!(expected && expected.querySelector(".till-stored-note")),
      rowHeight: Math.round(rowBox.height),
      colspan: cell ? cell.getAttribute("colspan") : null,
      cellWidth: Math.round(cellBox.width),
      tableWidth: Math.round(tableBox.width),
    };
  });
  expect(reconSpan.noteInsideExpected, JSON.stringify(reconSpan)).toBe(false);
  expect(reconSpan.colspan, JSON.stringify(reconSpan)).toBe("6");
  expect(reconSpan.cellWidth, JSON.stringify(reconSpan)).toBeGreaterThanOrEqual(reconSpan.tableWidth - 2);
  expect(reconSpan.rowHeight, JSON.stringify(reconSpan)).toBeLessThanOrEqual(80);
  const reconNote = jpy.locator("xpath=following-sibling::tr[1]");
  await expect(reconNote).toContainText("Rounded from 489,175.85 JPY");
  const reconInk = await panelContrast(reconNote.locator(".till-stored-note"));
  expect(reconInk.ratio, "reconcile stored row " + JSON.stringify(reconInk.ink)).toBeGreaterThanOrEqual(4.5);

  /* The wide table. The close reads "and", and the expected total keeps
     the two CAD places. num() drops the trailing zero, so 5,451.6 here
     is the bug. */
  const wideExpected = recon.locator("tfoot td").nth(2);
  await expect(wideExpected).toHaveText("5,451.60");
  const wideClose = page.locator(".till-recon-desk").getByRole("button", { name: "Close day and lock book" });
  await expect(wideClose).toBeVisible();
  await expect(page.locator(".till-recon-desk").getByRole("button", { name: /Close day & lock book/i })).toHaveCount(0);

  await page.locator('#appbar [data-app="reports"]').evaluate((el: HTMLElement) => el.click());
  await page.getByText("End-of-Day Sign-Off").first().click();
  const eodTable = page.locator("table").filter({ hasText: "In the drawer" });
  const eod = eodTable.locator("tr", { hasText: "JPY" }).first();
  await expect(eod).toContainText("489,176");
  await expect(eod).not.toContainText("Rounded from");
  const noteRow = eod.locator("xpath=following-sibling::tr[1]");
  await expect(noteRow).toContainText("Rounded from 489,175.85 JPY stored from older deals. It clears when the ledger is trued up.");
  const ink = await noteRow.locator(".till-stored-line").evaluate((el) => {
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
    if (width === 360 || width === 390) {
      const lineFit = await noteRow.evaluate((row) => {
        const line = row.querySelector(".till-stored-line");
        const card = row.closest(".report-scroll") || row.closest("#cdos-report-doc");
        if (!line || !card) return null;
        const box = card.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(line);
        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
        return {
          text: line.textContent || "",
          rects: rects.map((r) => ({ left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) })),
          cardLeft: Math.round(box.left),
          cardRight: Math.round(box.right),
          cardWidth: Math.round(box.width),
          lineWidth: Math.round(line.getBoundingClientRect().width),
          inside: rects.every((r) => r.left >= box.left - 1 && r.right <= box.right + 1),
        };
      });
      expect(lineFit, "stored line").toBeTruthy();
      expect(lineFit!.text).toContain("It clears when the ledger is trued up.");
      expect(lineFit!.rects.length).toBeGreaterThan(0);
      expect(lineFit!.inside, JSON.stringify(lineFit)).toBe(true);
    }
  }
});

async function saveYenCount(sessionId: string, counted: string, variance: string) {
  const key = `yen-${counted}-${Date.now()}`;
  await pool.query(
    `INSERT INTO ledger_till_count_batches
      (batch_id,session_id,tenant_id,legal_entity_id,branch_id,workspace_id,
       till_id,count_kind,actor_id,idempotency_key,counted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,
             'interim',$3||':j.masri',$1,now())`,
    [key, sessionId, TENANT, ENTITY, BRANCH, WS, TILL],
  );
  await pool.query(
    `INSERT INTO ledger_till_counts
      (batch_id,currency,expected_amount,counted_amount,variance_amount)
     VALUES ($1,'JPY',489175.85,$2,$3)`,
    [key, counted, variance],
  );
}

test("end of day shows plus one for 489177 and minus one for 489175", async ({ page }) => {
  await openTill(page);
  const sessionId = await page.evaluate(async () => {
    const answer = await fetch("/api/ledger/till-session").then((response) => response.json());
    return answer.session && answer.session.sessionId;
  });
  expect(sessionId).toBeTruthy();
  await saveYenCount(sessionId, "489177.00", "1.00");
  await page.reload();
  await landOnDesktop(page);
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("End-of-Day Sign-Off").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
  const variance = () => page.locator("table").filter({ hasText: "In the drawer" }).locator("tr", { hasText: "JPY" }).first().locator("td").nth(4);
  await expect(variance()).toContainText("+1");
  await expect(variance()).not.toContainText("-1");

  await saveYenCount(sessionId, "489175.00", "-1.00");
  await page.reload();
  await landOnDesktop(page);
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("End-of-Day Sign-Off").first().click();
  await expect(variance()).toContainText("-1");
  await expect(variance()).not.toContainText("+1");
});
