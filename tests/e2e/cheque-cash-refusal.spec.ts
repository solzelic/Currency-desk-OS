/* A refused cashing stays on the ticket. The amber line above
   Cash & hold is an alert, the typed values stay, and the text
   clears 4.5:1 on the fee banner ground. */
import path from "node:path";
import { createRequire } from "node:module";
import type { Page } from "@playwright/test";
import { test, expect, hasLedger, signInAtDesk } from "./fixtures";
import { clearChequeSchedule, storeChequeSchedule } from "./cheque-floor";

test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
};
const TENANT = "tnt-yorkfx";
type DeskQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type DeskSnap = { balances: { currency: string; amount: string }[]; session: string | null; schedule: string | null };
let deskSnap: DeskSnap | null = null;

async function withDesk<T>(run: (query: DeskQuery) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try { return await run((sql, params) => pool.query(sql, params)); }
  finally { await pool.end(); }
}

test.beforeEach(async () => {
  deskSnap = await withDesk(async (query) => {
    const balances = await query("SELECT btrim(currency) AS currency, available_amount FROM ledger_till_balances WHERE tenant_id=$1 AND till_id='till-01'", [TENANT]);
    const session = await query("SELECT session_id FROM ledger_till_sessions WHERE tenant_id=$1 AND till_id='till-01' AND status='open'", [TENANT]);
    const state = await query("SELECT state->>'cdos_cheque_schedule_v1' AS schedule FROM tenant_state WHERE tenant_id=$1", [TENANT]);
    return {
      balances: balances.rows.map((row) => ({ currency: String(row.currency), amount: String(row.available_amount) })),
      session: session.rows[0] ? String(session.rows[0].session_id) : null,
      schedule: state.rows[0] && state.rows[0].schedule != null ? String(state.rows[0].schedule) : null,
    };
  });
});

test.afterEach(async () => {
  const saved = deskSnap;
  deskSnap = null;
  if (!saved) return;
  await withDesk(async (query) => {
    for (const row of saved.balances) {
      await query("UPDATE ledger_till_balances SET available_amount=$3 WHERE tenant_id=$1 AND till_id='till-01' AND btrim(currency)=$2", [TENANT, row.currency, row.amount]);
    }
    if (saved.schedule == null) {
      await query("UPDATE tenant_state SET state = state - 'cdos_cheque_schedule_v1' WHERE tenant_id=$1", [TENANT]);
    } else {
      await query("UPDATE tenant_state SET state = jsonb_set(state, '{cdos_cheque_schedule_v1}', to_jsonb($2::text), true) WHERE tenant_id=$1", [TENANT, saved.schedule]);
    }
    await query(
      "UPDATE ledger_till_sessions SET status='closed', closed_by=opened_by, closed_at=now(), close_note='cheque refusal spec' WHERE tenant_id=$1 AND till_id='till-01' AND status='open' AND session_id IS DISTINCT FROM $2::text",
      [TENANT, saved.session],
    );
  });
});

const NO_FEES = "Nothing was cashed. This desk has no cheque fees yet. The owner or a manager sets them in Cheques, Fee schedule.";
const UNKNOWN = "Nothing was cashed. That cheque type isn't on this desk's fee list. Pick another type.";
const BELOW = "Nothing was cashed. That fee is below the schedule for this cheque.";

const TICKET = {
  customer: "Nia Pell",
  amount: "1000.25",
  number: "44190",
  maker: "Harbour Payroll",
  bank: "RBC Royal Bank",
};

async function chequesOpaque(page: Page) {
  await page.waitForFunction(() => {
    const win = document.querySelector("#desktop .win.active");
    if (!win || !/Cheque clearing/i.test(win.textContent || "")) return false;
    if (parseFloat(getComputedStyle(win).opacity) < 1) return false;
    return win.getAnimations().every((anim) => {
      const effect = anim.effect;
      const timing = effect && "getTiming" in effect ? effect.getTiming() : null;
      if (timing && timing.iterations === Infinity) return true;
      return anim.playState === "finished" || anim.playState === "idle";
    });
  });
}

async function openCheques(page: Page) {
  const more = page.locator('#phonebar [data-phone-app="more"]');
  if (await more.isVisible()) {
    await more.click();
    await page.locator('#phone-more [data-phone-app="cheques"]').click();
  } else {
    await page.getByText(/^Cheques$/).first().click();
  }
  await expect(page.getByText(/Cheque clearing/i).first()).toBeVisible({ timeout: 30_000 });
  await chequesOpaque(page);
}

async function openTill(page: Page) {
  const status = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") return "open";
    const opened = await fetch("/api/ledger/till-sessions/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return opened.ok ? "open" : `${opened.status} ${await opened.text()}`;
  });
  expect(status, "the till would not open").toBe("open");
}

async function fillTicket(page: Page) {
  await page.getByRole("button", { name: /Cash a cheque/i }).first().click();
  await expect(page.getByRole("button", { name: /Cash & hold/i })).toBeVisible();
  await page.getByPlaceholder("Type a name…").fill(TICKET.customer);
  await page.getByRole("button", { name: /^Payroll$/ }).click();
  await page.getByPlaceholder("0.00").fill(TICKET.amount);
  await page.getByPlaceholder("e.g. 004821").fill(TICKET.number);
  await page.getByPlaceholder("Payer name / business").fill(TICKET.maker);
  await page.getByPlaceholder("e.g. RBC Royal Bank").fill(TICKET.bank);
}

async function expectTicket(page: Page, maker = TICKET.maker) {
  await expect(page.getByPlaceholder("Type a name…")).toHaveValue(TICKET.customer);
  await expect(page.getByPlaceholder("0.00")).toHaveValue(TICKET.amount);
  await expect(page.getByPlaceholder("e.g. 004821")).toHaveValue(TICKET.number);
  await expect(page.getByPlaceholder("Payer name / business")).toHaveValue(maker);
  await expect(page.getByPlaceholder("e.g. RBC Royal Bank")).toHaveValue(TICKET.bank);
}

async function contrast(page: Page) {
  return page.getByTestId("cheque-cash-error").evaluate((el) => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const L = (rgb: string) => {
      const parts = rgb.match(/\d+/g);
      if (!parts || parts.length < 3) return 0;
      const [r, g, b] = parts.map(Number);
      return 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255);
    };
    const pair = (fg: string, bg: string) =>
      (Math.max(L(fg), L(bg)) + 0.05) / (Math.min(L(fg), L(bg)) + 0.05);
    const banner = getComputedStyle(el);
    const icon = el.querySelector("svg");
    const stroke = icon ? getComputedStyle(icon).stroke : "";
    const button = [...document.querySelectorAll("button")].find((node) => /Cash & hold|Posting/.test(node.textContent || ""));
    const bannerBox = el.getBoundingClientRect();
    const buttonBox = button ? button.getBoundingClientRect() : null;
    return {
      text: pair(banner.color, banner.backgroundColor),
      icon: stroke && stroke !== "none" ? pair(stroke, banner.backgroundColor) : 0,
      fontSize: banner.fontSize,
      role: el.getAttribute("role"),
      above: buttonBox ? bannerBox.bottom <= buttonBox.top + 1 : false,
    };
  });
}

test("payroll of 1,000.25 at 2% shows a fee of $20.01 and a front of $980.24", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await openTill(page);
  await openCheques(page);
  await fillTicket(page);
  const ticket = page.locator(".fixed").filter({ hasText: "Cash & hold" });
  await expect(ticket).toContainText("fee $20.01");
  await expect(ticket).toContainText("$980.24");
  await expect(ticket).not.toContainText("$20.00");
  await expect(ticket).not.toContainText("$980.25");
});

test("a refused cashing keeps the ticket and shows the amber alert", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await signInAtDesk(page, "m.costa");
  const skip = page.locator(".cdos-tour-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await openTill(page);
  await clearChequeSchedule();
  await openCheques(page);
  await fillTicket(page);
  await expect(page.getByText("fee $20.01").first()).toBeVisible();
  await page.getByRole("button", { name: /Cash & hold/i }).click();

  const banner = page.getByRole("alert");
  await expect(banner).toHaveText(NO_FEES);
  await expectTicket(page);
  const tone = await contrast(page);
  expect(tone.role).toBe("alert");
  expect(tone.text).toBeGreaterThanOrEqual(4.5);
  expect(tone.icon).toBeGreaterThanOrEqual(4.5);
  expect(tone.fontSize).toBe("13px");
  expect(tone.above).toBe(true);

  await page.getByPlaceholder("Payer name / business").fill(`${TICKET.maker} x`);
  await expect(page.getByTestId("cheque-cash-error")).toHaveCount(0);
  await expectTicket(page, `${TICKET.maker} x`);

  await page.route("**/api/ledger/cheques", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    body.chequeType = "PAYROLL";
    await route.continue({ postData: JSON.stringify(body) });
  });
  await page.getByRole("button", { name: /Cash & hold/i }).click();
  await expect(page.getByRole("alert")).toHaveText(UNKNOWN);
  await expectTicket(page, `${TICKET.maker} x`);
  await page.unroute("**/api/ledger/cheques");

  const rows = ["government", "payroll", "certified", "money_order", "business", "personal"].map((id) => ({
    id, label: id, feePct: id === "payroll" ? 2 : 0, feeMin: id === "payroll" ? 5 : 0, holdDays: 1, risk: "low",
  }));
  await storeChequeSchedule(rows);
  await page.route("**/api/ledger/cheques", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    body.feeAmount = "0.00";
    await route.continue({ postData: JSON.stringify(body) });
  });
  await page.getByRole("button", { name: /Cash & hold/i }).click();
  await expect(page.getByRole("alert")).toHaveText(BELOW);
  await expectTicket(page, `${TICKET.maker} x`);
  const below = await contrast(page);
  expect(below.text).toBeGreaterThanOrEqual(4.5);
  expect(below.icon).toBeGreaterThanOrEqual(4.5);

  await page.getByPlaceholder("0.00").fill("1000.26");
  await expect(page.getByTestId("cheque-cash-error")).toHaveCount(0);
  await expect(page.getByPlaceholder("e.g. 004821")).toHaveValue(TICKET.number);

  const booked = await page.evaluate(async () => {
    const body = await fetch("/api/ledger/cheques").then((r) => r.json());
    return (body.cheques || []).some((row: { chequeNumber?: string }) => row.chequeNumber === "44190");
  });
  expect(booked).toBe(false);
});
