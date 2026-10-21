/* The till's business date is the branch's civil day.

   With the server process on UTC, 00:05 in Asia/Jerusalem is 21:05 UTC
   the day before. Stamping that UTC day makes Reports, the till
   end-of-day sheet, and the dashboard ask for a window that has
   already ended, so the deal posted at 00:05 is missing for the
   whole session. 11:55 pm in Jerusalem is still that UTC day. 11:55 pm
   in Toronto is already the next UTC day.

   The screens build the window from the session's business date, at
   local midnight in the branch zone (cdos-base.jsx businessDayWindow).
   This process stays on UTC, so the test computes those same bounds
   in the branch zone. The seam in tests/e2e/ledger-drawer-movement.spec.ts
   seeds the browser's civil day itself. This test asks the server to
   stamp it, by opening the till. */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

const JERUSALEM = "Asia/Jerusalem";
const TORONTO = "America/Toronto";
/* 00:05 IDT on 2026-10-21. Israel is still on IDT (UTC+3) until 25 Oct. */
const JUST_AFTER_MIDNIGHT = "2026-10-20T21:05:00.000Z";
const JERUSALEM_DAY = "2026-10-21";
/* 23:55 IDT the same day. UTC has not rolled. */
const LATE_JERUSALEM = "2026-10-21T20:55:00.000Z";
/* 23:55 EDT on 2026-10-21. UTC has already rolled to the 22nd. */
const LATE_TORONTO = "2026-10-22T03:55:00.000Z";
const TORONTO_DAY = "2026-10-21";

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("sign-in did not set a session cookie");
  return { cdos_session: c.value };
};

function assertUtcProcess() {
  const probe = new Date("2026-06-15T12:00:00.000Z");
  if (probe.getTimezoneOffset() !== 0) {
    throw new Error(
      `This test runs with the server process on TZ=UTC. The offset was ${probe.getTimezoneOffset()} minutes.`,
    );
  }
}

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
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  let hour = pick("hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(pick("year"), pick("month") - 1, pick("day"), hour, pick("minute"), pick("second"));
  return asUtc - utcMs;
}

function midnightOn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    throw new Error(`Not a civil date: ${day}`);
  }
  const guess = Date.UTC(year, month - 1, date);
  const first = guess - zoneOffsetMs(timeZone, guess);
  return new Date(guess - zoneOffsetMs(timeZone, first));
}

function addCivilDay(day: string, n: number): string {
  const [year, month, date] = day.split("-").map(Number);
  if (year === undefined || month === undefined || date === undefined) {
    throw new Error(`Not a civil date: ${day}`);
  }
  return new Date(Date.UTC(year, month - 1, date + n, 12)).toISOString().slice(0, 10);
}

/* Reports "today" and the till end-of-day sheet ask for one day.
   The dashboard's default range is 30. Both end at the next local
   midnight of the session's business date. */
function branchDayWindow(businessDate: string, timeZone: string, days: number) {
  const endDay = addCivilDay(businessDate, 1);
  const startDay = addCivilDay(endDay, -Math.max(1, days || 1));
  return {
    from: midnightOn(startDay, timeZone).toISOString(),
    to: midnightOn(endDay, timeZone).toISOString(),
  };
}

function clockLabel(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

postgres("a till session takes the branch's civil day", () => {
  beforeAll(async () => {
    assertUtcProcess();
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await pool.query(
      "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
    );
    await pool.query("DELETE FROM sessions WHERE user_id LIKE $1", [`${DEMO.tenantId}:bd.%`]);
    await pool.query("DELETE FROM staff_users WHERE tenant_id=$1 AND staff_id LIKE 'bd.%'", [DEMO.tenantId]);
    await pool.query("DELETE FROM rate_boards WHERE tenant_id=$1 AND branch_id<>$2", [DEMO.tenantId, DEMO.branchId]);
    await pool.query("DELETE FROM workspaces WHERE tenant_id=$1 AND id<>$2", [DEMO.tenantId, DEMO.workspaceId]);
    await pool.query("DELETE FROM branches WHERE tenant_id=$1 AND id<>$2", [DEMO.tenantId, DEMO.branchId]);
    await seed(handle.db);
    app = await buildApp(handle.db);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function login(staffId: string, password = DEMO.password) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId, password, tenantId: DEMO.tenantId },
    });
    expect(res.statusCode, res.body).toBe(200);
    return cookieOf(res);
  }

  async function postedOn(cookies: Record<string, string>, workspaceId: string, window: { from: string; to: string }) {
    const summary = await app.inject({
      method: "GET",
      url: `/api/ledger/summary?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
      cookies,
      headers: { "x-workspace-id": workspaceId },
    });
    expect(summary.statusCode, summary.body).toBe(200);
    return summary.json().posted as number;
  }

  async function shift(input: { tag: string; zone: string; at: string; day: string; place: string }) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(input.at));
    const owner = await login("j.masri");
    const location = await app.inject({
      method: "POST",
      url: "/api/desk/branches",
      cookies: owner,
      payload: { name: input.place, timezone: input.zone },
    });
    expect(location.statusCode, location.body).toBe(201);
    const branchId = location.json().branch.id as string;
    const workspaceId = location.json().tills[0].workspaceId as string;
    expect(location.json().branch.timezone).toBe(input.zone);
    for (const [currency, perCad] of [["CAD", 1], ["USD", 0.73]] as const) {
      await pool.query("INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
        DEMO.tenantId, DEMO.legalEntityId, branchId, workspaceId, currency, perCad,
      ]);
    }
    const openerId = `bd.${input.tag}.open`;
    const closerId = `bd.${input.tag}.hand`;
    const password = "branch-day-1";
    for (const [staffId, role, name] of [
      [openerId, "supervisor", "Day opener"],
      [closerId, "teller", "Day closer"],
    ] as const) {
      const hired = await app.inject({
        method: "POST",
        url: "/api/staff",
        cookies: owner,
        payload: { staffId, name, role, branchId, password },
      });
      expect(hired.statusCode, hired.body).toBe(201);
    }
    const opener = await login(openerId, password);
    const headers = { "x-workspace-id": workspaceId };
    expect((await app.inject({
      method: "POST",
      url: "/api/ledger/opening-balances",
      cookies: opener,
      headers,
      payload: { balances: { CAD: "25000.00", USD: "4000.00" } },
    })).statusCode).toBe(201);
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: opener,
      headers,
    });
    expect(opened.statusCode, opened.body).toBe(201);
    expect(opened.json().session.businessDate).toBe(input.day);
    expect(opened.json().session.timezone).toBe(input.zone);
    const customer = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies: opener,
      headers,
      payload: { name: "Walk-in", risk: "normal", idStatus: "verified" },
    });
    expect(customer.statusCode, customer.body).toBe(201);
    const deal = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: opener,
      headers,
      payload: {
        idempotencyKey: `branch-day-${input.tag}`,
        customerId: customer.json().customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "4.00",
        purpose: "Travel",
        sourceOfFunds: "Employment income",
        thirdParty: false,
      },
    });
    expect(deal.statusCode, deal.body).toBe(201);
    const balances = await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies: opener,
      headers,
    });
    expect(balances.statusCode, balances.body).toBe(200);
    const counts = Object.fromEntries(
      Object.entries(balances.json().balances as Record<string, string>).map(([currency, amount]) => [
        currency,
        Number(amount).toFixed(2),
      ]),
    );
    const closer = await login(closerId, password);
    const handed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/handover",
      cookies: closer,
      headers,
      payload: { idempotencyKey: `branch-day-hand-${input.tag}`, counts },
    });
    expect(handed.statusCode, handed.body).toBe(201);
    expect(handed.json().session.businessDate).toBe(input.day);
    expect(handed.json().session.timezone).toBe(input.zone);
    const day = handed.json().session.businessDate as string;
    const reports = branchDayWindow(day, input.zone, 1);
    const endOfDay = branchDayWindow(day, input.zone, 1);
    const dashboard = branchDayWindow(day, input.zone, 30);
    expect(await postedOn(opener, workspaceId, reports)).toBe(1);
    expect(await postedOn(opener, workspaceId, endOfDay)).toBe(1);
    expect(await postedOn(opener, workspaceId, dashboard)).toBe(1);
  }

  it("stamps 00:05 IDT as the Jerusalem day, and the deal stays on that day", async () => {
    const at = new Date(JUST_AFTER_MIDNIGHT);
    expect(clockLabel(JERUSALEM, at)).toBe(`${JERUSALEM_DAY} 00:05`);
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-20");
    await shift({
      tag: "j0005",
      zone: JERUSALEM,
      at: JUST_AFTER_MIDNIGHT,
      day: JERUSALEM_DAY,
      place: "Jerusalem early",
    });
  });

  it("stamps 11:55 pm IDT as that same Jerusalem day", async () => {
    const at = new Date(LATE_JERUSALEM);
    expect(clockLabel(JERUSALEM, at)).toBe(`${JERUSALEM_DAY} 23:55`);
    expect(at.toISOString().slice(0, 10)).toBe(JERUSALEM_DAY);
    await shift({
      tag: "j2355",
      zone: JERUSALEM,
      at: LATE_JERUSALEM,
      day: JERUSALEM_DAY,
      place: "Jerusalem late",
    });
  });

  it("stamps 11:55 pm in Toronto as the Toronto day", async () => {
    const at = new Date(LATE_TORONTO);
    expect(clockLabel(TORONTO, at)).toBe(`${TORONTO_DAY} 23:55`);
    expect(at.toISOString().slice(0, 10)).toBe("2026-10-22");
    await shift({
      tag: "t2355",
      zone: TORONTO,
      at: LATE_TORONTO,
      day: TORONTO_DAY,
      place: "Toronto late",
    });
  });
});
