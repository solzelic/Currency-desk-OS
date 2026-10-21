/* Cash drawer movement is the book's figure. Two stored payouts of
   100.40 yen read Paid out 200 on an open day. A summary the desk
   cannot read says the ledger has no answer, and does not print the
   browser's own sum of those rows.

   The till's business date is the civil day the branch is trading.
   Yorkville stores America/Toronto. The desk turns that day into a
   window at midnight in the branch zone, not the browser's. A UTC
   date is still the previous day at 00:05 in Asia/Jerusalem, and
   seeding the browser's day puts the open drawer's yen outside the
   Toronto window. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

const ISRAEL = "Asia/Jerusalem";
/* Yorkville's branches.timezone. The window is midnight here, whichever
   zone the browser is standing in. */
const BRANCH_ZONE = "America/Toronto";

/* YYYY-MM-DD in a named zone. en-CA's parts are the year, the month,
   and the day, so the string does not depend on the machine's locale. */
function civilDay(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function addCivilDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1, 12)).toISOString().slice(0, 10);
}

/* How far the zone is ahead of UTC at this instant, in milliseconds.
   The first guess can land on the other side of a daylight-saving
   change, so the caller asks twice. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)!.value);
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"), pick("second"));
  return asUtc - utcMs;
}

function zonedInstant(timeZone: string, day: string, hour: number, minute: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  const utcGuess = Date.UTC(y!, m! - 1, d!, hour, minute, 0);
  const first = utcGuess - zoneOffsetMs(timeZone, utcGuess);
  return new Date(utcGuess - zoneOffsetMs(timeZone, first));
}

/* 00:05 or 23:55 on a Jerusalem day whose branch window is still
   open. The open-day total rounds only while that window's end is
   in the future. The end is the next midnight in the branch zone.
   Jerusalem midnight is hours later, so waiting on it leaves the
   Toronto day already closed. */
function israelClock(hour: number, minute: number): Date {
  let day = civilDay(ISRAEL, new Date());
  let instant = zonedInstant(ISRAEL, day, hour, minute);
  const windowEnd = (at: Date) =>
    zonedInstant(BRANCH_ZONE, addCivilDay(civilDay(BRANCH_ZONE, at)), 0, 0);
  if (windowEnd(instant).getTime() - Date.now() < 2 * 60 * 60 * 1000) {
    day = addCivilDay(day);
    instant = zonedInstant(ISRAEL, day, hour, minute);
  }
  const shown = new Intl.DateTimeFormat("en-GB", {
    timeZone: ISRAEL,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  const want = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (shown !== want) throw new Error(`${shown} is not ${want} in ${ISRAEL}`);
  return instant;
}

/* The day written on the till session. The desk builds its window
   from this day at midnight in the branch's zone, so the stored day
   is that zone's civil day. The UTC date is the previous day at
   00:05 in Asia/Jerusalem, and a window built from the Jerusalem
   day has already ended in Toronto. */
function tradingDay(timeZone: string, at: Date): string {
  return civilDay(timeZone, at);
}

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

let pool: { query: Function; end: () => Promise<void> };

async function seedBook(input: {
  workspace: string;
  till: string;
  session: string;
  tag: string;
  businessDate: string;
  postedAt: Date;
}) {
  await pool.query(
    `INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [input.workspace, TENANT, ENTITY, BRANCH, input.till],
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7,'open',$2||':j.masri',$8)
     ON CONFLICT (session_id) DO UPDATE SET business_date = EXCLUDED.business_date`,
    [input.session, TENANT, ENTITY, BRANCH, input.workspace, input.till, input.businessDate, input.postedAt],
  );
  const book = [TENANT, ENTITY, BRANCH, input.workspace, input.till];
  for (const suffix of ["a", "b"]) {
    const id = `${input.tag}-${suffix}`;
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id,
          workspace_id, till_id, customer_id, actor_id, from_currency, to_currency,
          input_amount, output_amount, rate, fee_cad, spread_cad, purpose,
          source_of_funds, posted_at, deal_kind, received_instrument, disbursed_instrument,
          jurisdiction_pack_id, jurisdiction_pack_version, home_currency)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, 'customer-demo', $3||':j.masri',
          'CAD', 'JPY', 100.00, 100.40, 1, 0, 0, 'travel', 'salary', $8,
          'exchange', 'cash', 'cash', 'pack-ca-v1', 1, 'CAD')
       ON CONFLICT (transaction_id) DO NOTHING`,
      [id, `ref-${id}`, ...book, input.postedAt],
    );
  }
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  const at = new Date();
  await seedBook({
    workspace: WS,
    till: TILL,
    session: "session-drawer-book",
    tag: "drawer-jpy",
    businessDate: tradingDay(BRANCH_ZONE, at),
    postedAt: at,
  });
});

test.afterAll(async () => {
  if (pool) await pool.end();
});

async function openSummary(page: Page, till = TILL) {
  await signInAtDesk(page, "j.masri");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator('#appbar [data-app="till"]').click();
  const switcher = page.locator('xpath=//button[@title="Switch till at this location" and not(ancestor::*[@id="tenantbar"])]');
  await switcher.click();
  await page.getByRole("button", { name: till }).click();
  await page.getByRole("button", { name: /Switch till|Take over till/i }).last().click();
  await expect(page.getByText(new RegExp("ledger till\\s+" + till)).first()).toBeVisible({ timeout: 20_000 });
  await page.locator('#appbar [data-app="reports"]').click();
  await page.getByText("Period Summary").first().click();
  await page.locator("#cdos-report-doc").waitFor({ state: "visible", timeout: 30_000 });
}

async function expectRoundedDrawer(page: Page) {
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

/* The same open drawer, with the browser standing in Jerusalem
   and the till at Yorkville. 00:05 IDT is 21:05 UTC the day before
   (22:05 UTC while Israel is on standard time). 11:55 pm is still
   that UTC day. The stored day is Toronto's. The Toronto window of
   the Jerusalem date starts the next morning and misses 00:05. */
test.describe("the open drawer around Jerusalem midnight", () => {
  test.use({ timezoneId: ISRAEL });

  test("an open drawer at 00:05 IDT still rounds the yen", async ({ page }) => {
    const at = israelClock(0, 5);
    const utc = at.toISOString();
    expect(utc.slice(0, 10) < civilDay(ISRAEL, at)).toBe(true);
    expect(["21:05", "22:05"]).toContain(utc.slice(11, 16));
    await seedBook({
      workspace: "ws-drawer-0005",
      till: "till-drawer-0005",
      session: "session-drawer-0005",
      tag: "drawer-0005",
      businessDate: tradingDay(BRANCH_ZONE, at),
      postedAt: at,
    });
    await page.clock.install({ time: at });
    await openSummary(page, "till-drawer-0005");
    await expectRoundedDrawer(page);
  });

  test("an open drawer at 11:55 pm IDT still rounds the yen", async ({ page }) => {
    const at = israelClock(23, 55);
    expect(at.toISOString().slice(0, 10)).toBe(civilDay(ISRAEL, at));
    await seedBook({
      workspace: "ws-drawer-2355",
      till: "till-drawer-2355",
      session: "session-drawer-2355",
      tag: "drawer-2355",
      businessDate: tradingDay(BRANCH_ZONE, at),
      postedAt: at,
    });
    await page.clock.install({ time: at });
    await openSummary(page, "till-drawer-2355");
    await expectRoundedDrawer(page);
  });
});
