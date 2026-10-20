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

async function expectInk(target: Locator, label: string) {
  const ink = await panelContrast(target);
  expect(ink.ratio, label + " " + JSON.stringify(ink.ink)).toBeGreaterThanOrEqual(4.5);
  return ink;
}

async function paintOf(target: Locator) {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      color: style.color,
      background: style.backgroundColor,
      size: style.fontSize,
      weight: style.fontWeight,
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  });
}

/* Scroll the reconcile list to its end, with a block in front of the
   close so the bar is what lands at the bottom. The tab bar covers
   that bottom edge. The close and its note have to finish above it. */
async function assertCloseClearsDock(page: Page) {
  const fit = await page.evaluate(() => {
    const close = document.querySelector(".till-recon-close") as HTMLElement | null;
    if (!close || !close.parentElement) return { error: "no close" };
    let scroller: HTMLElement | null = close.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return { error: "no scroller" };
    const before = document.createElement("div");
    before.className = "seam-scroll-spacer";
    before.style.height = "720px";
    close.parentElement.insertBefore(before, close);
    scroller.scrollTop = scroller.scrollHeight;
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        height: Math.round(r.height),
      };
    };
    const dock = box(document.querySelector("#phone-dock"));
    const button = box(close.querySelector(".till-recon-close-btn"));
    const note = box(close.querySelector(".till-recon-close-note"));
    const overlap = (
      a: { top: number; bottom: number; left: number; right: number } | null,
      c: { top: number; bottom: number; left: number; right: number } | null,
    ) => !!(a && c && a.bottom > c.top + 1 && a.top < c.bottom - 1 && a.right > c.left + 1 && a.left < c.right - 1);
    const result = {
      scrollTop: Math.round(scroller.scrollTop),
      dock,
      button,
      note,
      buttonHits: overlap(button, dock),
      noteHits: overlap(note, dock),
    };
    before.remove();
    scroller.scrollTop = 0;
    return result;
  });
  expect(fit.buttonHits, JSON.stringify(fit)).toBe(false);
  expect(fit.noteHits, JSON.stringify(fit)).toBe(false);
  expect(fit.button && fit.dock && fit.button.bottom <= fit.dock.top + 1, JSON.stringify(fit)).toBe(true);
  expect(fit.note && fit.dock && fit.note.bottom <= fit.dock.top + 1, JSON.stringify(fit)).toBe(true);
}

/* The pinned dock covers the bottom of the list until the teller
   scrolls. The rounding note has to be able to sit fully above it. */
async function assertNoteClearsClose(page: Page) {
  const fit = await page.evaluate(() => {
    const note = document.querySelector(".till-recon-note") as HTMLElement | null;
    const close = document.querySelector(".till-recon-close") as HTMLElement | null;
    if (!note || !close) return { error: "missing" };
    let scroller: HTMLElement | null = note.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY)) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) return { error: "no scroller" };
    for (let i = 0; i < 8; i++) {
      const gap = note.getBoundingClientRect().bottom - close.getBoundingClientRect().top;
      if (gap <= 1) break;
      scroller.scrollTop += gap + 8;
    }
    const nb = note.getBoundingClientRect();
    const cb = close.getBoundingClientRect();
    return {
      noteBottom: Math.round(nb.bottom),
      closeTop: Math.round(cb.top),
      scrollTop: Math.round(scroller.scrollTop),
      clear: nb.bottom <= cb.top + 1,
    };
  });
  expect(fit.clear, JSON.stringify(fit)).toBe(true);
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
  await page.setViewportSize({ width: 1280, height: 780 });
  await expect(page.locator(".till-recon table")).toBeVisible();
  await expect(page.locator(".till-recon-list")).toHaveCount(1);
  await expect(page.locator(".till-recon-list")).toBeHidden();
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

  /* The wide table, at 600px and up. The close reads "and", and the
     expected total keeps the two CAD places. num() drops the trailing
     zero, so 5,451.6 here is the bug. */
  const wideExpected = recon.locator("tfoot td").nth(2);
  await expect(wideExpected).toHaveText("5,451.60");
  const wideClose = page.locator(".till-recon-desk").getByRole("button", { name: "Close day and lock book" });
  await expect(wideClose).toBeVisible();
  await expect(page.locator(".till-recon-desk").getByRole("button", { name: /Close day & lock book/i })).toHaveCount(0);
  const list = page.locator(".till-recon-list");
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(list).toBeVisible();
  await expect(page.locator(".till-recon table")).toBeHidden();
  await expect(list.locator(".till-recon-title")).toHaveText("Close the till");
  const titlePaint = await paintOf(list.locator(".till-recon-title"));
  expect(titlePaint.size).toBe("28px");
  expect(["700", "bold"]).toContain(titlePaint.weight);
  const lead = list.locator(".till-recon-lead");
  await expect(lead).toHaveText("Count the cash in your drawer. We compare it to what the system expects, then lock the day.");
  const leadPaint = await paintOf(lead);
  expect(leadPaint.color).toBe("rgb(74, 74, 80)");
  expect(leadPaint.size).toBe("15px");
  await expectInk(lead, "lead");
  const countStep = list.locator('.till-recon-step[data-step="Count"]');
  const checkStep = list.locator('.till-recon-step[data-step="Check"]');
  const closeStep = list.locator('.till-recon-step[data-step="Close"]');
  await expect(countStep).toHaveAttribute("data-state", "current");
  await expect(checkStep).toHaveAttribute("data-state", "upcoming");
  await expect(closeStep).toHaveAttribute("data-state", "upcoming");
  const countMark = await paintOf(countStep.locator(".till-recon-step-mark"));
  expect(countMark.background).toBe("rgb(0, 0, 0)");
  expect(countMark.color).toBe("rgb(255, 255, 255)");
  expect(countMark.width).toBe(24);
  expect(countMark.height).toBe(24);
  for (const step of [checkStep, closeStep]) {
    const mark = await paintOf(step.locator(".till-recon-step-mark"));
    const label = await paintOf(step.locator(".till-recon-step-label"));
    expect(mark.background).toBe("rgb(255, 255, 255)");
    expect(label.color).toBe("rgb(108, 108, 112)");
    await expectInk(step.locator(".till-recon-step-label"), "step");
  }
  await expectInk(countStep.locator(".till-recon-step-label"), "current step");
  const progress = list.locator(".till-recon-progress");
  await expect(progress).toHaveText("1 of 2 counted");
  const progressPaint = await paintOf(progress);
  expect(progressPaint.color).toBe("rgb(94, 94, 99)");
  expect(progressPaint.size).toBe("13px");
  await expectInk(progress, "progress");
  const jpyCard = list.locator(".till-recon-item", { hasText: "JPY" });
  const cadCard = list.locator(".till-recon-item", { hasText: "CAD" });
  await expect(jpyCard.locator(".till-recon-name")).toHaveText("Japanese Yen");
  const namePaint = await paintOf(jpyCard.locator(".till-recon-name"));
  expect(namePaint.color).toBe("rgb(94, 94, 99)");
  expect(namePaint.size).toBe("13px");
  await expectInk(jpyCard.locator(".till-recon-name"), "name");
  await expectInk(cadCard.locator(".till-recon-name"), "cad name");
  await expect(jpyCard.locator(".till-recon-you")).toHaveText("You counted");
  const youPaint = await paintOf(jpyCard.locator(".till-recon-you"));
  expect(youPaint.color).toBe("rgb(94, 94, 99)");
  expect(youPaint.size).toBe("12px");
  await expectInk(jpyCard.locator(".till-recon-you"), "you counted");
  await expect(jpyCard.locator(".till-recon-counted")).toHaveText("489,177");
  await expect(jpyCard.locator(".till-recon-expected")).toHaveText("Expected 489,176");
  const expectedPaint = await paintOf(jpyCard.locator(".till-recon-expected"));
  expect(expectedPaint.color).toBe("rgb(94, 94, 99)");
  await expectInk(jpyCard.locator(".till-recon-expected"), "expected");
  await expectInk(cadCard.locator(".till-recon-expected"), "cad expected");
  const overChip = jpyCard.locator(".till-recon-chip");
  await expect(overChip).toHaveText("1 yen over");
  const overPaint = await paintOf(overChip);
  expect(overPaint.color).toBe("rgb(168, 50, 31)");
  expect(overPaint.background).toBe("rgb(253, 236, 230)");
  await expectInk(overChip, "over chip");
  await expect(jpyCard.locator(".till-recon-note")).toHaveText("Expected is rounded from 489,175.85 from older deals.");
  await expectInk(jpyCard.locator(".till-recon-note"), "rounding note");
  const cadCount = cadCard.getByRole("button", { name: "Count" });
  const cadTap = await paintOf(cadCount);
  expect(cadTap.height).toBeGreaterThanOrEqual(44);
  expect(cadTap.width).toBeGreaterThanOrEqual(88);
  await expect(cadCard.locator(".till-recon-expected")).toHaveText("Expected 1,000.50");
  const hint = list.locator(".till-recon-hint");
  await expect(hint).toHaveText("Count every currency to see your total.");
  await expect(list.locator(".till-recon-total-card")).toHaveCount(0);
  await expectInk(hint, "hint");
  const close = list.getByRole("button", { name: "Close the day" });
  await expect(close).toBeDisabled();
  const disabledPaint = await paintOf(close);
  expect(disabledPaint.background).toBe("rgb(209, 209, 214)");
  expect(disabledPaint.color).toBe("rgb(60, 60, 67)");
  expect(disabledPaint.height).toBeGreaterThanOrEqual(50);
  await expectInk(close, "disabled close");
  const closeNote = list.locator(".till-recon-close-note");
  await expect(closeNote).toHaveText("Count 1 more currency first.");
  const notePaint = await paintOf(closeNote);
  expect(notePaint.color).toBe("rgb(94, 94, 99)");
  await expectInk(closeNote, "dock note");
  const phoneCopy = await page.locator(".till-screen .overflow-auto").innerText();
  expect(phoneCopy).not.toContain("&");
  expect(phoneCopy).not.toMatch(/[—–]/);
  expect(phoneCopy).not.toContain("1/2 counted");
  await expect(page.getByText("1/2 counted").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".till-move").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".till-sessionline").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".till-statusline").filter({ visible: true })).toHaveCount(0);
  await expect(page.locator(".till-recon-widehead")).toHaveCount(1);
  await expect(page.locator(".till-recon-widehead")).toBeHidden();
  const safetyStays = await page.evaluate(() => {
    const host = document.querySelector(".till-on-reconcile");
    if (!host) return { alert: true, open: true };
    const probe = (className: string) => {
      const el = document.createElement("div");
      el.className = className;
      el.textContent = "probe";
      host.appendChild(el);
      const hidden = getComputedStyle(el).display === "none";
      el.remove();
      return hidden;
    };
    return { alert: probe("till-alert"), open: probe("till-open-needed") };
  });
  expect(safetyStays.alert).toBe(false);
  expect(safetyStays.open).toBe(false);
  const refused = page.waitForRequest(
    (req) => req.method() === "POST" && req.url().includes("/close"),
    { timeout: 600 },
  ).then(() => true, () => false);
  await close.evaluate((el: HTMLElement) => el.click());
  expect(await refused).toBe(false);
  await expect(page.getByText("Review each drawer against expected")).toHaveCount(0);
  await assertNoteClearsClose(page);
  await assertCloseClearsDock(page);
  await page.setViewportSize({ width: 430, height: 780 });
  await assertCloseClearsDock(page);
  await page.setViewportSize({ width: 360, height: 780 });

  await cadCount.evaluate((el: HTMLElement) => el.click());
  await page.getByRole("button", { name: /^Enter total$/ }).click();
  await page.locator('input[placeholder="0.00"]').fill("1000.50");
  await page.locator(".till-expected").evaluate((el: HTMLElement) => el.click());
  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  await expect(hint).toHaveCount(0);
  const overTotal = list.locator(".till-recon-total-card");
  await expect(overTotal).toBeVisible();
  const overDiff = overTotal.locator(".till-recon-diff");
  await expect(overDiff).toHaveText("+0.01 · Over");
  const overDiffPaint = await paintOf(overDiff);
  expect(overDiffPaint.color).toBe("rgb(168, 50, 31)");
  await expectInk(overDiff, "over difference");

  await jpyCard.locator(".till-recon-code").evaluate((el: HTMLElement) => el.click());
  await page.locator('input[placeholder="0.00"]').fill("489175");
  await page.locator(".till-expected").evaluate((el: HTMLElement) => el.click());
  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  const underChip = jpyCard.locator(".till-recon-chip");
  await expect(underChip).toHaveText("1 yen under");
  const underPaint = await paintOf(underChip);
  expect(underPaint.color).toBe("rgb(168, 50, 31)");
  expect(underPaint.background).toBe("rgb(253, 236, 230)");
  await expectInk(underChip, "under chip");
  const underDiff = list.locator(".till-recon-diff");
  await expect(underDiff).toHaveText("-0.01 · Under");
  expect((await paintOf(underDiff)).color).toBe("rgb(168, 50, 31)");
  await expectInk(underDiff, "under difference");

  await jpyCard.locator(".till-recon-code").evaluate((el: HTMLElement) => el.click());
  await page.locator('input[placeholder="0.00"]').fill("489176");
  await page.locator(".till-expected").evaluate((el: HTMLElement) => el.click());
  await page.locator('[data-tour="till-reconcile-tab"]').evaluate((el: HTMLElement) => el.click());
  await expect(countStep).toHaveAttribute("data-state", "done");
  await expect(checkStep).toHaveAttribute("data-state", "current");
  await expect(closeStep).toHaveAttribute("data-state", "upcoming");
  const doneMark = await paintOf(countStep.locator(".till-recon-step-mark"));
  expect(doneMark.background).toBe("rgb(29, 107, 69)");
  expect(doneMark.color).toBe("rgb(255, 255, 255)");
  await expect(progress).toHaveText("Both currencies counted");
  for (const card of [jpyCard, cadCard]) {
    const chip = card.locator(".till-recon-chip");
    await expect(chip).toHaveText("Matches");
    const chipPaint = await paintOf(chip);
    expect(chipPaint.color).toBe("rgb(29, 107, 69)");
    expect(chipPaint.background).toBe("rgb(229, 242, 234)");
    await expectInk(chip, "match chip");
  }
  await expect(hint).toHaveCount(0);
  const totalCard = list.locator(".till-recon-total-card");
  await expect(totalCard).toBeVisible();
  await expect(totalCard.locator(".till-recon-total-label")).toHaveText("TOTAL IN CAD");
  await expectInk(totalCard.locator(".till-recon-total-label"), "total label");
  for (const label of ["Expected", "Counted", "Difference"]) {
    await expectInk(totalCard.locator(".till-recon-total-line", { hasText: label }).locator("span").first(), label);
  }
  await expect(totalCard.locator(".till-recon-total-expected")).toHaveText("5,451.60");
  const diff = totalCard.locator(".till-recon-diff");
  await expect(diff).toHaveText("0.00 · Balanced");
  const diffPaint = await paintOf(diff);
  expect(diffPaint.color).toBe("rgb(29, 107, 69)");
  await expectInk(diff, "balanced difference");
  await expect(close).toBeEnabled();
  const readyPaint = await paintOf(close);
  expect(readyPaint.background).toBe("rgb(0, 0, 0)");
  expect(readyPaint.color).toBe("rgb(255, 255, 255)");
  await expect(closeNote).toHaveText("This locks today's records. You can't edit them after.");
  await expectInk(closeNote, "ready note");
  const readyCopy = await page.locator(".till-screen .overflow-auto").innerText();
  expect(readyCopy).not.toContain("&");
  expect(readyCopy).not.toMatch(/[—–]/);
  await page.setViewportSize({ width: 599, height: 780 });
  await expect(list).toBeVisible();
  await expect(page.locator(".till-recon table")).toBeHidden();
  await page.setViewportSize({ width: 600, height: 780 });
  await expect(list).toBeHidden();
  await expect(page.locator(".till-recon table")).toBeVisible();
  await expect(wideExpected).toHaveText("5,451.60");
  await expect(wideClose).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 780 });
  await expect(page.locator(".till-recon table")).toBeVisible();
  await expect(list).toBeHidden();

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
