/* The date bugs that stayed green.

   A window that is merely "later than now", an expiry that is merely
   "not before a UTC date", and a deal reference that happens to share
   today's digits all pass while the rule is wrong. These four walks
   are the ones that go red when that rule is replaced with the UTC
   clock or a flat 24 hours.

   The browser stays on UTC. The branch is Toronto or Jerusalem. A
   browser-local midnight and the branch midnight are different instants
   in both of those zones, which is the only way a local window is
   visible from the test. */
import { createRequire } from "node:module";
import path from "node:path";
import { test, expect, hasLedger, signInAtDesk, landOnDesktop } from "./fixtures";
import type { Page } from "@playwright/test";

const requireFromServer = createRequire(path.join(process.cwd(), "server", "package.json"));
const { Pool } = requireFromServer("pg") as {
  Pool: new (config: { connectionString: string }) => {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: { timezone: string }[] }>;
    end: () => Promise<void>;
  };
};

test.describe.configure({ mode: "serial" });
test.use({ timezoneId: "UTC" });
test.skip(!hasLedger, "needs SEAM_DATABASE_URL — the embedded database has no ledger");

/* cash-seam needs the demo drawer never to have been opened. This
   file trades on its own till, the same way the day-long shift does. */
const GAP_TILL = "till-date-gap";
let gapWorkspaceId = "";

const JERUSALEM_AFTER_MIDNIGHT = "2026-10-12T00:30:00+03:00";
const TORONTO_BEFORE_MIDNIGHT = "2026-10-11T23:30:00-04:00";
const TORONTO_AFTER_UTC_MIDNIGHT = "2026-10-12T00:30:00Z";

function freezeClock(iso: string) {
  const fixed = Date.parse(iso);
  const RealDate = Date;
  function FakeDate(this: Date, ...args: unknown[]) {
    if (!new.target) return new RealDate(fixed).toString();
    if (args.length === 0) return new RealDate(fixed);
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => fixed;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate as unknown as DateConstructor;
}

async function arm(page: Page, at: string, seen: string[], freeze = false) {
  if (freeze) await page.addInitScript(freezeClock, at);
  await page.route("**/*", async (route) => {
    seen.push(route.request().url());
    const headers = { ...route.request().headers(), "x-cd-now": at };
    await route.continue({ headers });
  });
}

async function setBranchZone(timeZone: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    const current = await pool.query("SELECT timezone FROM branches WHERE id = 'br-yorkville'");
    const previous = current.rows[0]?.timezone;
    if (!previous) throw new Error("br-yorkville has no timezone row");
    await pool.query("UPDATE branches SET timezone = $1 WHERE id = 'br-yorkville'", [timeZone]);
    return previous;
  } finally {
    await pool.end();
  }
}

async function restoreBranchZone(timeZone: string) {
  const pool = new Pool({ connectionString: process.env.SEAM_DATABASE_URL! });
  try {
    await pool.query("UPDATE branches SET timezone = $1 WHERE id = 'br-yorkville'", [timeZone]);
  } finally {
    await pool.end();
  }
}

async function ensureGapTill(page: Page): Promise<void> {
  if (!gapWorkspaceId) {
    const created = await page.evaluate(async (tillId) => {
      const response = await fetch("/api/desk/branches/br-yorkville/tills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ tillId }),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }, GAP_TILL);
    const id = created.body.till?.workspaceId ?? created.body.workspaceId;
    if (!id) throw new Error(`the date-gap till could not be added: ${JSON.stringify(created)}`);
    gapWorkspaceId = id as string;
  }
  const ws = gapWorkspaceId;
  await page.addInitScript((workspaceId) => {
    const orig = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/ledger") && !url.includes("/api/quotes")) return orig(input, init);
      const headers = new Headers(init?.headers);
      if (!headers.has("x-workspace-id")) headers.set("x-workspace-id", workspaceId as string);
      return orig(input, { ...init, headers });
    };
  }, ws);
  await page.evaluate(async (workspaceId) => {
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("/api/ledger") && !url.includes("/api/quotes")) return orig(input, init);
      const headers = new Headers(init?.headers);
      if (!headers.has("x-workspace-id")) headers.set("x-workspace-id", workspaceId);
      return orig(input, { ...init, headers });
    };
    const me = await fetch("/api/auth/me").then((r) => r.json());
    if (me.user?.id) localStorage.setItem(`cdesk.ledger.till.${me.user.id}`, workspaceId);
    if (window.CDOS?.Backend?.selectWorkspace) {
      const resolved = await window.CDOS.Backend.selectWorkspace(workspaceId);
      window.CDOS.Backend.setWorkspace(resolved.workspaceId || workspaceId);
    }
  }, ws);
}

async function countExactlyAndClose(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const balances: Record<string, string> = held.balances ?? {};
    const counts = Object.fromEntries(
      Object.entries(balances).map(([c, v]) => [c, Number(v).toFixed(2)]),
    );
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status !== "open") return { ok: true, why: "already closed" };
    const counted = await fetch("/api/ledger/till-counts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: `${k}-count`, counts }),
    });
    if (!counted.ok) return { ok: false, why: `count: ${counted.status} ${await counted.text()}` };
    const closed = await fetch(`/api/ledger/till-sessions/${current.session.sessionId}/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: `${k}-close`,
        counts,
        balanceGeneration: held.balanceGeneration,
        note: "All counted drawers balanced",
      }),
    });
    if (!closed.ok) return { ok: false, why: `close: ${closed.status} ${await closed.text()}` };
    return { ok: true, why: "" };
  }, key);
}

async function openDeskApp(page: Page, id: string) {
  await page.locator(`#appbar [data-app="${id}"]`).click();
}

async function ensureDrawer(page: Page, stamp: string) {
  return page.evaluate(async (stamp) => {
    const held = await fetch("/api/ledger/till-balances").then((r) => r.json());
    const want: Record<string, number> = { CAD: 5000, USD: 5000 };
    const done: string[] = [];
    for (const [currency, amount] of Object.entries(want)) {
      const have = Number(held.balances?.[currency] ?? 0);
      if (have >= amount) continue;
      const answer = await fetch("/api/ledger/till-movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: `gap-topup-${currency}-${stamp}`,
          direction: "in",
          currency,
          amount: (amount - have).toFixed(2),
          counterpartyType: "bank",
          counterpartyRef: "business-date-gap",
          reason: "Top-up so the date gap can post a deal",
        }),
      });
      done.push(answer.ok ? `${currency}:ok` : `${currency}:${answer.status} ${await answer.text()}`);
    }
    return done.join(" · ");
  }, stamp);
}

async function ensureBoard(page: Page) {
  const published = await page.evaluate(async () => {
    const priced = await fetch("/api/rates").then((r) => r.json()).catch(() => null);
    if (priced?.board?.rows?.USD) return "already published";
    const manager = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" }),
    });
    if (!manager.ok) return `manager sign-in: ${manager.status}`;
    const answer = await fetch("/api/rates/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buyMargin: 0.02,
        sellMargin: 0.03,
        rows: { USD: { mid: 1.4, show: true }, EUR: { mid: 1.5, show: true } },
      }),
    });
    return answer.ok ? "published" : `publish: ${answer.status} ${await answer.text()}`;
  });
  if (published === "published") {
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
  }
  return published;
}

async function postOneDeal(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const customers = await fetch("/api/ledger/customers").then((r) => r.json());
    let customerId = customers.customers?.[0]?.customerId as string | undefined;
    if (!customerId) {
      const made = await fetch("/api/ledger/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalRef: `gap-${k}`,
          name: "Date Gap",
          risk: "normal",
          idStatus: "verified",
        }),
      });
      if (!made.ok) return { ok: false, why: `customer ${made.status} ${await made.text()}` };
      customerId = (await made.json()).customerId;
    }
    const quote = await fetch("/api/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId,
        feeCad: "7.50",
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        direction: "customer_buy_foreign",
      }),
    });
    if (!quote.ok) return { ok: false, why: `quote ${quote.status} ${await quote.text()}` };
    const frozen = await quote.json();
    const posted = await fetch(`/api/quotes/${frozen.quoteId}/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: k,
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
      }),
    });
    if (!posted.ok) return { ok: false, why: `post ${posted.status} ${await posted.text()}` };
    return { ok: true, ...(await posted.json()) };
  }, key);
}

async function openSession(page: Page) {
  const status = await page.evaluate(async () => {
    const current = await fetch("/api/ledger/till-session").then((r) => r.json());
    if (current.session?.status === "open") {
      return { opened: false, session: current };
    }
    const opened = await fetch("/api/ledger/till-sessions/open", { method: "POST" });
    const body = await opened.json().catch(() => ({}));
    if (!opened.ok) return { opened: false, error: `${opened.status} ${JSON.stringify(body)}` };
    const again = await fetch("/api/ledger/till-session").then((r) => r.json());
    return { opened: true, session: again };
  });
  return status;
}

async function waitForZone(page: Page, timeZone: string) {
  await expect.poll(async () => page.evaluate(async (zone) => {
    const session = await fetch("/api/ledger/till-session").then((r) => r.json());
    const named = session.day && session.day.timeZone;
    if (named && window.CDOS && window.CDOS.setBranchTimeZone) window.CDOS.setBranchTimeZone(named);
    return named === zone ? named : "";
  }, timeZone), { timeout: 20_000 }).toBe(timeZone);
}

function summaryWindows(urls: string[]) {
  return urls.filter((url) => url.includes("/api/ledger/summary")).map((url) => {
    const parsed = new URL(url);
    return { from: parsed.searchParams.get("from"), to: parsed.searchParams.get("to") };
  });
}

async function fileIdentity(page: Page, name: string, expiresOn: string, stamp: string) {
  return page.evaluate(async ({ name, expiresOn, stamp }) => {
    const created = await fetch("/api/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ legalName: name }),
    });
    if (!created.ok) return { ok: false, why: `client ${created.status} ${await created.text()}` };
    const client = await created.json();
    const doc = await fetch(`/api/clients/${client.clientId}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docType: "Passport",
        docNumber: `P${stamp}`,
        expiresOn,
        isPrimary: true,
      }),
    });
    if (!doc.ok) return { ok: false, why: `document ${doc.status} ${await doc.text()}` };
    const read = await fetch(`/api/clients/${client.clientId}`);
    if (!read.ok) return { ok: false, why: `read ${read.status} ${await read.text()}` };
    const body = await read.json();
    return { ok: true, verificationStatus: body.verificationStatus as string };
  }, { name, expiresOn, stamp });
}

test("the cash drawer asks for the session window, not the browser's midnight", async ({ page }) => {
  const seen: string[] = [];
  let previous: string | null = null;
  let transactionId: string | null = null;
  const at = JERUSALEM_AFTER_MIDNIGHT;
  try {
    await arm(page, at, seen);
    previous = await setBranchZone("Asia/Jerusalem");
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
    const closed = await countExactlyAndClose(page, `gap-till-close-${Date.now()}`);
    expect(closed.ok, closed.why).toBe(true);
    const opened = await openSession(page);
    expect(opened.error, "the till would not open").toBeUndefined();
    const day = opened.session.day;
    expect(day.businessDate).toBe("2026-10-12");
    expect(day.from).toBe("2026-10-11T21:00:00.000Z");
    expect(day.to).toBe("2026-10-12T21:00:00.000Z");
    const topped = await ensureDrawer(page, `till-${Date.now()}`);
    expect(topped, topped).not.toMatch(/:4\d\d|:5\d\d/);
    const board = await ensureBoard(page);
    expect(board).toMatch(/published/);
    const deal = await postOneDeal(page, `gap-till-${Date.now()}`);
    expect(deal.ok, deal.why).toBe(true);
    transactionId = deal.transactionId;
    await page.reload();
    await landOnDesktop(page);
    await waitForZone(page, "Asia/Jerusalem");
    const mark = seen.length;
    await openDeskApp(page, "till");
    await expect.poll(() => summaryWindows(seen.slice(mark)).length).toBeGreaterThan(0);
    const asked = summaryWindows(seen.slice(mark));
    expect(asked).toContainEqual({ from: day.from, to: day.to });
    const local = asked.find((window) => window.from === "2026-10-12T00:00:00.000Z");
    expect(local).toBeUndefined();
  } finally {
    if (transactionId) {
      const reversed = await page.evaluate(async (id) => {
        const answer = await fetch(`/api/ledger/transactions/${id}/reversal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `gap-rev-${id}`, reason: "Seam test" }),
        });
        return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
      }, transactionId);
      if (reversed !== "ok") throw new Error(`the deal was not reversed: ${reversed}`);
    }
    const closed = await countExactlyAndClose(page, `gap-till-done-${Date.now()}`);
    if (!closed.ok) throw new Error(closed.why);
    if (previous) await restoreBranchZone(previous);
    await page.unroute("**/*");
  }
});

test("an ID expiring today stays current in Toronto, on the status and the badge", async ({ page }) => {
  const seen: string[] = [];
  let previous: string | null = null;
  const at = TORONTO_BEFORE_MIDNIGHT;
  const name = `Gap Toronto ${Date.now()}`;
  try {
    await arm(page, at, seen, true);
    previous = await setBranchZone("America/Toronto");
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
    const closed = await countExactlyAndClose(page, `gap-tor-id-close-${Date.now()}`);
    expect(closed.ok, closed.why).toBe(true);
    const opened = await openSession(page);
    expect(opened.error).toBeUndefined();
    expect(opened.session.day.businessDate).toBe("2026-10-11");
    const filed = await fileIdentity(page, name, "2026-10-11", `tor-${Date.now()}`);
    expect(filed.ok, filed.why).toBe(true);
    expect(filed.verificationStatus).toBe("identified");
    await page.reload();
    await landOnDesktop(page);
    await waitForZone(page, "America/Toronto");
    await openDeskApp(page, "clients");
    const card = page.locator('div[role="button"]').filter({ hasText: name }).first();
    await expect(card.getByText("ID expiring", { exact: true })).toBeVisible();
    await expect(card.getByText("ID expired", { exact: true })).toHaveCount(0);
    await card.click();
    await expect(page.getByText("Identified", { exact: true })).toBeVisible();
  } finally {
    const closed = await countExactlyAndClose(page, `gap-tor-id-done-${Date.now()}`);
    if (!closed.ok) throw new Error(closed.why);
    if (previous) await restoreBranchZone(previous);
    await page.unroute("**/*");
  }
});

test("an ID expiring today stays current in Jerusalem, and one that expired yesterday does not", async ({ page }) => {
  const seen: string[] = [];
  let previous: string | null = null;
  const at = JERUSALEM_AFTER_MIDNIGHT;
  const stamp = Date.now();
  const todayName = `Gap Jerusalem today ${stamp}`;
  const yesterdayName = `Gap Jerusalem yesterday ${stamp}`;
  try {
    await arm(page, at, seen, true);
    previous = await setBranchZone("Asia/Jerusalem");
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
    const closed = await countExactlyAndClose(page, `gap-jlem-id-close-${stamp}`);
    expect(closed.ok, closed.why).toBe(true);
    const opened = await openSession(page);
    expect(opened.error).toBeUndefined();
    expect(opened.session.day.businessDate).toBe("2026-10-12");
    const today = await fileIdentity(page, todayName, "2026-10-12", `jlem-today-${stamp}`);
    expect(today.ok, today.why).toBe(true);
    expect(today.verificationStatus).toBe("identified");
    const yesterday = await fileIdentity(page, yesterdayName, "2026-10-11", `jlem-yesterday-${stamp}`);
    expect(yesterday.ok, yesterday.why).toBe(true);
    expect(yesterday.verificationStatus).toBe("expired");
    await page.reload();
    await landOnDesktop(page);
    await waitForZone(page, "Asia/Jerusalem");
    await openDeskApp(page, "clients");
    const current = page.locator('div[role="button"]').filter({ hasText: todayName }).first();
    const lapsed = page.locator('div[role="button"]').filter({ hasText: yesterdayName }).first();
    await expect(current.getByText("ID expiring", { exact: true })).toBeVisible();
    await expect(current.getByText("ID expired", { exact: true })).toHaveCount(0);
    await expect(lapsed.getByText("ID expired", { exact: true })).toBeVisible();
    await current.click();
    await expect(page.getByText("Identified", { exact: true })).toBeVisible();
    await page.locator("div.fixed.inset-0").last().click({ position: { x: 8, y: 8 } });
    await lapsed.click();
    await expect(page.getByText("ID expired", { exact: true }).last()).toBeVisible();
  } finally {
    const closed = await countExactlyAndClose(page, `gap-jlem-id-done-${stamp}`);
    if (!closed.ok) throw new Error(closed.why);
    if (previous) await restoreBranchZone(previous);
    await page.unroute("**/*");
  }
});

test("the dashboard's 30-day window ends at the branch midnight", async ({ page }) => {
  const seen: string[] = [];
  let previous: string | null = null;
  let transactionId: string | null = null;
  const at = TORONTO_AFTER_UTC_MIDNIGHT;
  try {
    await arm(page, at, seen);
    previous = await setBranchZone("America/Toronto");
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
    const closed = await countExactlyAndClose(page, `gap-dash-close-${Date.now()}`);
    expect(closed.ok, closed.why).toBe(true);
    const opened = await openSession(page);
    expect(opened.error).toBeUndefined();
    expect(opened.session.session.businessDate).toBe("2026-10-11");
    expect(opened.session.day.to).toBe("2026-10-12T04:00:00.000Z");
    const topped = await ensureDrawer(page, `dash-${Date.now()}`);
    expect(topped, topped).not.toMatch(/:4\d\d|:5\d\d/);
    const board = await ensureBoard(page);
    expect(board).toMatch(/published/);
    const deal = await postOneDeal(page, `gap-dash-${Date.now()}`);
    expect(deal.ok, deal.why).toBe(true);
    transactionId = deal.transactionId;
    await page.reload();
    await landOnDesktop(page);
    await waitForZone(page, "America/Toronto");
    const mark = seen.length;
    await openDeskApp(page, "dashboard");
    await expect.poll(() => summaryWindows(seen.slice(mark)).some((window) => window.to === "2026-10-12T04:00:00.000Z")).toBe(true);
    const asked = summaryWindows(seen.slice(mark));
    expect(asked.some((window) => window.to === "2026-10-12T00:00:00.000Z")).toBe(false);
  } finally {
    if (transactionId) {
      const reversed = await page.evaluate(async (id) => {
        const answer = await fetch(`/api/ledger/transactions/${id}/reversal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `gap-rev-${id}`, reason: "Seam test" }),
        });
        return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
      }, transactionId);
      if (reversed !== "ok") throw new Error(`the deal was not reversed: ${reversed}`);
    }
    const closed = await countExactlyAndClose(page, `gap-dash-done-${Date.now()}`);
    if (!closed.ok) throw new Error(closed.why);
    if (previous) await restoreBranchZone(previous);
    await page.unroute("**/*");
  }
});

test("a ledger row shows the branch calendar date of the posting, not the UTC date", async ({ page }) => {
  const seen: string[] = [];
  let previous: string | null = null;
  let transactionId: string | null = null;
  /* 17 October is not the day this suite runs. CD-261012 was that
     day on 12 October 2026, so a wall-clock reference matched it. */
  const at = "2026-10-17T00:30:00+03:00";
  expect(new Date().toISOString().slice(0, 10)).not.toBe("2026-10-17");
  try {
    await arm(page, at, seen);
    previous = await setBranchZone("Asia/Jerusalem");
    await signInAtDesk(page, "j.masri");
    await ensureGapTill(page);
    const closed = await countExactlyAndClose(page, `gap-row-close-${Date.now()}`);
    expect(closed.ok, closed.why).toBe(true);
    const opened = await openSession(page);
    expect(opened.error).toBeUndefined();
    const topped = await ensureDrawer(page, `row-${Date.now()}`);
    expect(topped, topped).not.toMatch(/:4\d\d|:5\d\d/);
    const board = await ensureBoard(page);
    expect(board).toMatch(/published/);
    const deal = await postOneDeal(page, `gap-row-${Date.now()}`);
    expect(deal.ok, deal.why).toBe(true);
    transactionId = deal.transactionId;
    const ref = deal.transactionRef as string;
    expect(ref).toMatch(/^CD-261017-/);
    expect(ref.startsWith("CD-261016-")).toBe(false);
    await page.reload();
    await landOnDesktop(page);
    await waitForZone(page, "Asia/Jerusalem");
    const ledger = page.locator(".win.show").filter({ hasText: "Ledger" }).first();
    if (await ledger.count()) {
      await ledger.locator(".win-close").click({ force: true });
    }
    await openDeskApp(page, "ledger");
    const row = page.locator("tr", { hasText: ref });
    await expect(row).toBeVisible();
    await expect(row).toContainText("2026-10-17");
    await expect(row).not.toContainText("2026-10-16");
  } finally {
    if (transactionId) {
      const reversed = await page.evaluate(async (id) => {
        const answer = await fetch(`/api/ledger/transactions/${id}/reversal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idempotencyKey: `gap-rev-${id}`, reason: "Seam test" }),
        });
        return answer.ok ? "ok" : `${answer.status} ${await answer.text()}`;
      }, transactionId);
      if (reversed !== "ok") throw new Error(`the deal was not reversed: ${reversed}`);
    }
    const closed = await countExactlyAndClose(page, `gap-row-done-${Date.now()}`);
    if (!closed.ok) throw new Error(closed.why);
    if (previous) await restoreBranchZone(previous);
    await page.unroute("**/*");
  }
});

/* The badge and the server standing already have their own walks.
   This is the other call: customerPayload in cdos-backend.js, the
   idStatus posted to /api/ledger/customers. Replacing that comparison
   with the UTC date leaves the badge green and still sends the wrong
   status. */
/* An empty drawer has nothing to count, and the close route refuses
   a count of no currencies. A till this file opened and never topped
   up is that drawer. Put a float in it, then count it out. */
async function closeGapTill(page: Page, key: string) {
  const closed = await countExactlyAndClose(page, key);
  if (closed.ok || !closed.why.startsWith("count:")) return closed;
  const topped = await ensureDrawer(page, key);
  if (/:4\d\d|:5\d\d/.test(topped)) return { ok: false, why: topped };
  return countExactlyAndClose(page, `${key}-b`);
}

async function sendDeskCustomer(page: Page, name: string) {
  const prepared = await page.evaluate(async (customerName) => {
    const listed = await window.CDOS.Backend.Clients.list();
    const found = (listed.clients || []).find((client: { legalName?: string }) => client.legalName === customerName);
    if (!found) return { ok: false as const, why: "client not listed" };
    const record = window.CDOS.Backend.Clients.toDeskRecord(found);
    return {
      ok: true as const,
      idExpiry: String(record.idExpiry || ""),
      idType: String(record.idType || ""),
      on: window.CDOS.branchCalendarDate(),
      browserZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }, name);
  if (!prepared.ok) return { prepared, sent: null as { idStatus?: string } | null, saved: "" };
  const pending = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().includes("/api/ledger/customers"));
  const saved = await page.evaluate(async (customerName) => {
    const listed = await window.CDOS.Backend.Clients.list();
    const found = (listed.clients || []).find((client: { legalName?: string }) => client.legalName === customerName);
    const record = window.CDOS.Backend.Clients.toDeskRecord(found);
    const body = await window.CDOS.Backend.syncCustomer(customerName, record);
    return String(body.idStatus || "");
  }, name);
  const request = await pending;
  return { prepared, sent: request.postDataJSON() as { idStatus?: string }, saved };
}

test.describe("desk ledger counter, Toronto evening", () => {
  test.use({ timezoneId: "America/Toronto" });

  test("an ID that expires today is sent as verified at 11:30 PM EDT", async ({ page }) => {
    const seen: string[] = [];
    let previous: string | null = null;
    const at = TORONTO_BEFORE_MIDNIGHT;
    const name = `Gap counter Toronto ${Date.now()}`;
    try {
      await arm(page, at, seen, true);
      previous = await setBranchZone("America/Toronto");
      await signInAtDesk(page, "j.masri");
      await ensureGapTill(page);
      const closed = await closeGapTill(page, `gap-tor-send-close-${Date.now()}`);
      expect(closed.ok, closed.why).toBe(true);
      const opened = await openSession(page);
      expect(opened.error).toBeUndefined();
      expect(opened.session.day.businessDate).toBe("2026-10-11");
      const filed = await fileIdentity(page, name, "2026-10-11", `tor-send-${Date.now()}`);
      expect(filed.ok, filed.why).toBe(true);
      await page.reload();
      await landOnDesktop(page);
      await waitForZone(page, "America/Toronto");
      const sent = await sendDeskCustomer(page, name);
      expect(sent.prepared.ok, sent.prepared.ok ? "" : sent.prepared.why).toBe(true);
      if (!sent.prepared.ok) return;
      expect(sent.prepared.browserZone).toBe("America/Toronto");
      expect(sent.prepared.idExpiry).toBe("2026-10-11");
      expect(sent.prepared.on).toBe("2026-10-11");
      expect(sent.sent?.idStatus).toBe("verified");
      expect(sent.saved).toBe("verified");
    } finally {
      const closed = await closeGapTill(page, `gap-tor-send-done-${Date.now()}`);
      if (!closed.ok) throw new Error(closed.why);
      if (previous) await restoreBranchZone(previous);
      await page.unroute("**/*");
    }
  });
});

test.describe("desk ledger counter, Jerusalem browser", () => {
  test.use({ timezoneId: "Asia/Jerusalem" });

  test("an ID that expired yesterday is sent as expired just after midnight", async ({ page }) => {
    const seen: string[] = [];
    let previous: string | null = null;
    /* 17 October is not the day this suite runs. An ID that expired
       the day before 12 October is already before today's UTC date,
       so the old comparison stays green when the suite runs that day.
       The assertion below refuses to run on 17 October itself. */
    const at = "2026-10-17T00:01:00+03:00";
    expect(new Date().toISOString().slice(0, 10)).not.toBe("2026-10-17");
    const name = `Gap counter Jerusalem ${Date.now()}`;
    try {
      await arm(page, at, seen, true);
      previous = await setBranchZone("Asia/Jerusalem");
      await signInAtDesk(page, "j.masri");
      await ensureGapTill(page);
      const closed = await closeGapTill(page, `gap-jlem-send-close-${Date.now()}`);
      expect(closed.ok, closed.why).toBe(true);
      const opened = await openSession(page);
      expect(opened.error).toBeUndefined();
      expect(opened.session.day.businessDate).toBe("2026-10-17");
      const filed = await fileIdentity(page, name, "2026-10-16", `jlem-send-${Date.now()}`);
      expect(filed.ok, filed.why).toBe(true);
      await page.reload();
      await landOnDesktop(page);
      await waitForZone(page, "Asia/Jerusalem");
      const sent = await sendDeskCustomer(page, name);
      expect(sent.prepared.ok, sent.prepared.ok ? "" : sent.prepared.why).toBe(true);
      if (!sent.prepared.ok) return;
      expect(sent.prepared.browserZone).toBe("Asia/Jerusalem");
      expect(sent.prepared.idExpiry).toBe("2026-10-16");
      expect(sent.prepared.on).toBe("2026-10-17");
      expect(sent.sent?.idStatus).toBe("expired");
      expect(sent.saved).toBe("expired");
    } finally {
      const closed = await closeGapTill(page, `gap-jlem-send-done-${Date.now()}`);
      if (!closed.ok) throw new Error(closed.why);
      if (previous) await restoreBranchZone(previous);
      await page.unroute("**/*");
    }
  });
});
