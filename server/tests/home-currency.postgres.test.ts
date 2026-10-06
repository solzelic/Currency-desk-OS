/* The owner moves the currency the books are kept in.

   Password, role, open tills, and a fresh market rate are all checked
   on the server. Past ledger rows stay in the currency they were posted
   in. The rate board is labelled with the old home and stops being the
   live board. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import Decimal from "decimal.js";
import { setSanctionedCurrencyLookup } from "../src/compliance/sanctioned-currencies.js";
import { requireIdentification } from "../src/ledger/service.js";
import { resolvePack } from "../src/ledger/jurisdiction.js";
import { publishFromMarket } from "../src/rates/market.js";
import { clearPinAttempts } from "../src/routes/pin.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;
let logged: string[] = [];
let earlyAccess: string | undefined;

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((entry) => entry.includes("[email simulated]"));
  const match = line?.match(/(\d{6}) is your/) ?? line?.match(/code is (\d{6})/);
  if (!match) throw new Error("no signup code in log");
  return match[1]!;
};

async function signup(slug: string, email: string, onboarding: Record<string, unknown>) {
  logged = [];
  const created = await app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      businessName: slug,
      ownerName: "Owner",
      email,
      password: "a-strong-pass",
      slug,
      onboarding,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const verified = await app.inject({
    method: "POST",
    url: "/api/signup/verify",
    payload: { email, code: codeFromLog() },
  });
  expect(verified.statusCode, verified.body).toBe(201);
  const cookie = verified.cookies.find((item) => item.name === "cdos_session")?.value;
  if (!cookie) throw new Error("no session");
  return cookie;
}

async function removeDesk(slug: string, email: string) {
  const tenant = `tnt-${slug}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const run = (sql: string, values: unknown[]) => client.query(sql, values);
    await run("DELETE FROM quote_events WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM quote_overrides WHERE quote_id IN (SELECT quote_id FROM quotes WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM quotes WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_counts WHERE batch_id IN (SELECT batch_id FROM ledger_till_count_batches WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_till_count_batches WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_cheque_events WHERE cheque_id IN (SELECT cheque_id FROM ledger_cheques WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_cheques WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_obligation_events WHERE obligation_id IN (SELECT obligation_id FROM ledger_obligations WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_obligations WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_movements WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_cost_lot_consumption WHERE event_id IN (SELECT event_id FROM ledger_cost_events WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_cost_lots WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_cost_events WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_journal_entries WHERE transaction_id IN (SELECT transaction_id FROM ledger_transactions WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM ledger_transactions WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_audit_events WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_idempotency WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_sessions WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_till_balances WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_customers WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM ledger_principals WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM desk_clients WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM staff_users WHERE tenant_id=$1)", [tenant]);
    await run("DELETE FROM staff_users WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM rate_boards WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM workspaces WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM branches WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM legal_entities WHERE id=$1", [`le-${slug}`]);
    await run("DELETE FROM audit_events WHERE tenant_id=$1", [tenant]);
    await run("DELETE FROM tenants WHERE id=$1", [tenant]);
    await run("DELETE FROM pending_signups WHERE email=$1", [email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

postgres("the owner changes the base currency", () => {
  const slug = "homeccy";
  const email = "owner@homeccy.example";
  const canada = { slug: "homeca", email: "owner@homeca.example" };
  const tenant = `tnt-${slug}`;
  const entity = `le-${slug}`;
  const branch = `br-${slug}-main`;
  const workspace = `ws-${slug}-till-01`;
  let cookie = "";
  const owner = () => ({ cdos_session: cookie });

  beforeAll(async () => {
    earlyAccess = process.env.EARLY_ACCESS_OPEN;
    process.env.EARLY_ACCESS_OPEN = "1";
    process.env.DATABASE_URL = url;
    process.env.LEDGER_DATABASE_URL = url;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    app = await buildApp(handle.db);
    await removeDesk(slug, email);
    await removeDesk(canada.slug, canada.email);
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-home-currency', 'test', $1::jsonb, now())`,
      [JSON.stringify({ USD: 1.36, GBP: 1.7, EUR: 1.5 })],
    );
    cookie = await signup(slug, email, { country: "XX" });
  });

  afterAll(async () => {
    setSanctionedCurrencyLookup(() => false);
    if (earlyAccess === undefined) delete process.env.EARLY_ACCESS_OPEN;
    else process.env.EARLY_ACCESS_OPEN = earlyAccess;
    vi.restoreAllMocks();
    if (pool && cookie) {
      await removeDesk(slug, email);
      await removeDesk(canada.slug, canada.email);
      await pool.query("DELETE FROM market_rates WHERE id LIKE 'snap-home%'");
    }
    await app?.close();
    await pool?.end();
    await handle?.close();
  });

  async function home(): Promise<string> {
    const row = await pool.query("SELECT home_currency FROM legal_entities WHERE id=$1", [entity]);
    return String(row.rows[0].home_currency).trim();
  }

  async function postChange(body: Record<string, unknown>, session = cookie) {
    const payload = { ...body };
    if (!payload.snapshotId && typeof payload.currency === "string") {
      const preview = await app.inject({
        method: "GET",
        url: `/api/ledger/home-currency/preview?currency=${encodeURIComponent(payload.currency)}`,
        cookies: { cdos_session: session },
      });
      const id = preview.statusCode === 200 ? preview.json().snapshotId : null;
      payload.snapshotId = id || "snap-home-missing";
    }
    return app.inject({
      method: "POST",
      url: "/api/ledger/home-currency",
      cookies: { cdos_session: session },
      payload,
    });
  }

  async function waitForWaitingLock(): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      const locks = await pool.query(
        `SELECT 1
           FROM pg_locks l
           JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'legal_entities' AND NOT l.granted
          LIMIT 1`,
      );
      if (locks.rowCount) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  }

  it("refuses a teller and a wrong password, and leaves the book in USD", async () => {
    const view = await app.inject({ method: "GET", url: "/api/ledger/home-currency", cookies: owner() });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ currency: "USD", owner: true });
    expect(view.json().choices).toContain("GBP");
    expect(view.json().choices).not.toContain("USD");

    const hired = await app.inject({
      method: "POST",
      url: "/api/staff",
      cookies: owner(),
      payload: { staffId: "teller.home", name: "Teller", role: "teller", password: "teller-pass-1" },
    });
    expect(hired.statusCode, hired.body).toBe(201);
    const signed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "teller.home", password: "teller-pass-1", tenantId: tenant },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const teller = signed.cookies.find((item) => item.name === "cdos_session")?.value;
    if (!teller) throw new Error("no teller session");
    const refused = await postChange({ currency: "GBP", password: "teller-pass-1" }, teller);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe("Only the owner can change the base currency.");

    const wrong = await postChange({ currency: "GBP", password: "not-the-password" });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().code).toBe("PASSWORD_REJECTED");
    expect(await home()).toBe("USD");
  });

  it("refuses while a till is open, and while a cash count is not closed out", async () => {
    const opened = await app.inject({ method: "POST", url: "/api/ledger/till-sessions/open", cookies: owner() });
    expect(opened.statusCode, opened.body).toBe(201);
    const blocked = await postChange({ currency: "GBP", password: "a-strong-pass" });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe("TILL_NOT_CLOSED");
    expect(blocked.json().message).toMatch(/still open/i);
    expect(await home()).toBe("USD");

    await pool.query(
      `INSERT INTO ledger_till_balances
        (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount)
       VALUES ($1,$2,$3,$4,'till-01','USD','100.00')`,
      [tenant, entity, branch, workspace],
    );
    const sessionId = opened.json().session.sessionId as string;
    const closed = await app.inject({
      method: "POST",
      url: `/api/ledger/till-sessions/${sessionId}/close`,
      cookies: owner(),
      payload: { idempotencyKey: "close-home-1", counts: { USD: "100.00" }, note: "" },
    });
    expect(closed.statusCode, closed.body).toBe(200);

    const again = await app.inject({ method: "POST", url: "/api/ledger/till-sessions/open", cookies: owner() });
    expect(again.statusCode, again.body).toBe(201);
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: owner(),
      payload: { idempotencyKey: "count-home-1", counts: { USD: "100.00" } },
    });
    expect(counted.statusCode, counted.body).toBe(201);
    const still = await postChange({ currency: "GBP", password: "a-strong-pass" });
    expect(still.statusCode).toBe(422);
    expect(still.json().code).toBe("TILL_NOT_CLOSED");
    expect(still.json().message).toMatch(/cash count/i);
    const second = again.json().session.sessionId as string;
    const finished = await app.inject({
      method: "POST",
      url: `/api/ledger/till-sessions/${second}/close`,
      cookies: owner(),
      payload: { idempotencyKey: "close-home-2", counts: { USD: "100.00" }, note: "" },
    });
    expect(finished.statusCode, finished.body).toBe(200);
    expect(await home()).toBe("USD");
  });

  it("refuses a stale snapshot and a snapshot that cannot price the new currency", async () => {
    await pool.query(
      "UPDATE market_rates SET fetched_at = now() - interval '25 hours' WHERE id LIKE 'snap-home%'",
    );
    const stale = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-currency",
    });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().code).toBe("HOME_RATE_UNAVAILABLE");
    expect(stale.json().message).toMatch(/24 hours/i);

    await pool.query("DELETE FROM market_rates WHERE id LIKE 'snap-home%'");
    const missing = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-currency",
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe("HOME_RATE_UNAVAILABLE");

    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-home-partial', 'test', '{"USD":1.36}'::jsonb, now())`,
    );
    const unpriced = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-partial",
    });
    expect(unpriced.statusCode).toBe(422);
    expect(unpriced.json().code).toBe("HOME_RATE_UNAVAILABLE");
    expect(unpriced.json().message).toMatch(/GBP/);
    expect(await home()).toBe("USD");
  });

  it("lets exactly one of a till open and a currency change win the row", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM legal_entities WHERE id = $1 FOR UPDATE", [entity]);
      const pending = app.inject({
        method: "POST",
        url: "/api/ledger/till-sessions/open",
        cookies: owner(),
      });
      expect(await waitForWaitingLock()).toBe(true);
      const openNow = await pool.query(
        "SELECT count(*)::int AS n FROM ledger_till_sessions WHERE tenant_id = $1 AND status = 'open'",
        [tenant],
      );
      expect(openNow.rows[0].n).toBe(0);
      await holder.query("ROLLBACK");
      const opened = await pending;
      expect(opened.statusCode, opened.body).toBe(201);
      const sessionId = opened.json().session.sessionId as string;
      const closed = await app.inject({
        method: "POST",
        url: `/api/ledger/till-sessions/${sessionId}/close`,
        cookies: owner(),
        payload: { idempotencyKey: "close-home-race", counts: { USD: "100.00" }, note: "" },
      });
      expect(closed.statusCode, closed.body).toBe(200);
    } finally {
      holder.release();
    }

    const share = await pool.connect();
    try {
      await share.query("BEGIN");
      await share.query("SELECT 1 FROM legal_entities WHERE id = $1 FOR SHARE", [entity]);
      const pending = postChange({
        currency: "GBP",
        password: "a-strong-pass",
        snapshotId: "snap-home-currency",
      });
      expect(await waitForWaitingLock()).toBe(true);
      const who = await pool.query("SELECT id FROM staff_users WHERE tenant_id = $1 LIMIT 1", [tenant]);
      await share.query(
        `INSERT INTO ledger_till_sessions
          (session_id, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
           session_number, business_date, status, opened_by, opened_at)
         VALUES ('till-session-race',$1,$2,$3,$4,'till-01',99, current_date, 'open', $5, now())`,
        [tenant, entity, branch, workspace, who.rows[0].id],
      );
      await share.query("COMMIT");
      const blocked = await pending;
      expect(blocked.statusCode, blocked.body).toBe(422);
      expect(blocked.json().code).toBe("TILL_NOT_CLOSED");
      expect(await home()).toBe("USD");
    } finally {
      share.release();
    }
    await pool.query("DELETE FROM ledger_till_sessions WHERE session_id = 'till-session-race'");
  });

  it("refuses while an obligation is open or a cheque is held", async () => {
    const who = await pool.query("SELECT id FROM staff_users WHERE tenant_id = $1 LIMIT 1", [tenant]);
    await pool.query(
      `INSERT INTO ledger_transactions
        (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
         fee_cad, spread_cad, purpose, source_of_funds, posted_at, deal_kind, received_instrument,
         disbursed_instrument, home_currency)
       VALUES ('tx-home-block','TX-HOME-BLOCK',$1,$2,$3,$4,'till-01','cust-home',$5,'USD','GBP',100,80,0.8,
               0,0,'travel','salary',now(),'exchange','cash','cash','USD')`,
      [tenant, entity, branch, workspace, who.rows[0].id],
    );
    await pool.query(
      `INSERT INTO ledger_obligations
        (obligation_id, obligation_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         customer_id, transaction_id, kind, direction, counterparty, face_currency, face_amount,
         home_currency, carrying_amount_home, status, opened_at, created_by)
       VALUES ('ob-home-1','OB-HOME-1',$1,$2,$3,$4,'till-01','cust-home','tx-home-block',
               'remittance_payable','payable','Western Union','USD',100,'USD',100,'open',now(),$5)`,
      [tenant, entity, branch, workspace, who.rows[0].id],
    );
    const owed = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-partial",
    });
    expect(owed.statusCode).toBe(422);
    expect(owed.json().code).toBe("BOOKS_NOT_CLEAR");
    expect(owed.json().message).toMatch(/obligation/i);
    expect(await home()).toBe("USD");
    await pool.query("DELETE FROM ledger_obligations WHERE obligation_id = 'ob-home-1'");

    await pool.query(
      `INSERT INTO ledger_cheques
        (cheque_id, cheque_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         customer_id, cheque_number, maker, cheque_type, type_label, currency,
         face_amount, fee_amount, net_amount, hold_until, received_date, status,
         cashing_transaction_id, created_by)
       VALUES ('chq-home-1','CHQ-HOME-1',$1,$2,$3,$4,'till-01','cust-home','1001','A Maker',
               'personal','Personal','USD',100,0,100, current_date, current_date, 'held',
               'tx-home-block',$5)`,
      [tenant, entity, branch, workspace, who.rows[0].id],
    );
    const held = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-partial",
    });
    expect(held.statusCode).toBe(422);
    expect(held.json().code).toBe("BOOKS_NOT_CLEAR");
    expect(held.json().message).toMatch(/cheque/i);
    expect(await home()).toBe("USD");
    await pool.query("DELETE FROM ledger_cheques WHERE cheque_id = 'chq-home-1'");
  });

  it("locks the keypad after five wrong passwords and keeps the audit row", async () => {
    const who = await pool.query("SELECT id FROM staff_users WHERE tenant_id = $1 AND role = 'administrator' ORDER BY created_at, id LIMIT 1", [tenant]);
    const ownerId = String(who.rows[0].id);
    clearPinAttempts(ownerId);
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM ledger_audit_events
        WHERE tenant_id = $1 AND action = 'desk.home_currency.password_failed'`,
      [tenant],
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await postChange({
        currency: "GBP",
        password: "not-the-password",
        snapshotId: "snap-home-partial",
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().code).toBe("PASSWORD_REJECTED");
    }
    const locked = await postChange({
      currency: "GBP",
      password: "not-the-password",
      snapshotId: "snap-home-partial",
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("PASSWORD_LOCKED");
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM ledger_audit_events
        WHERE tenant_id = $1 AND action = 'desk.home_currency.password_failed'`,
      [tenant],
    );
    expect(after.rows[0].n - before.rows[0].n).toBe(5);
    expect(await home()).toBe("USD");
    clearPinAttempts(ownerId);
  });

  it("keeps the ledger, writes the audit row, and the desk follows GBP", async () => {
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-home-fresh', 'test', $1::jsonb, now() + interval '2 minutes')`,
      [JSON.stringify({ USD: 1.36, GBP: 1.7, EUR: 1.5 })],
    );
    setSanctionedCurrencyLookup((code) => code === "IRR");
    const banned = await postChange({ currency: "IRR", password: "a-strong-pass" });
    expect(banned.statusCode).toBe(422);
    expect(banned.json().code).toBe("CURRENCY_SANCTIONED");
    const listed = await app.inject({ method: "GET", url: "/api/ledger/home-currency", cookies: owner() });
    expect(listed.json().choices).not.toContain("IRR");
    setSanctionedCurrencyLookup(() => false);

    const tightened = await app.inject({
      method: "PUT",
      url: "/api/ledger/desk-thresholds",
      cookies: owner(),
      payload: { reportThreshold: "1000.00" },
    });
    expect(tightened.statusCode, tightened.body).toBe(200);

    const ownerId = await pool.query("SELECT id FROM staff_users WHERE tenant_id=$1 AND role='administrator'", [tenant]);
    await pool.query(
      `INSERT INTO ledger_transactions
        (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
         fee_cad, spread_cad, purpose, source_of_funds, posted_at, deal_kind, received_instrument,
         disbursed_instrument, home_currency)
       VALUES ('tx-home-1','TX-HOME-1',$1,$2,$3,$4,'till-01','cust-home',$5,'USD','GBP',100,80,0.8,
               0,0,'travel','salary',now(),'exchange','cash','cash','USD')`,
      [tenant, entity, branch, workspace, ownerId.rows[0].id],
    );
    const beforeBoard = await pool.query(
      `SELECT board_rows, home_currency FROM rate_boards
        WHERE tenant_id=$1 ORDER BY published_at DESC LIMIT 1`,
      [tenant],
    );

    const preview = await app.inject({
      method: "GET",
      url: "/api/ledger/home-currency/preview?currency=GBP",
      cookies: owner(),
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().willChange.join(" ")).toMatch(/books in GBP/);
    expect(preview.json().willChange.join(" ")).toMatch(/1 USD = 0\.8000 GBP/);
    expect(preview.json().willChange.join(" ")).not.toMatch(/fetched at/);
    expect(preview.json().willNotChange.join(" ")).toMatch(/not rewritten|keep the currency/i);
    expect(preview.json().blockers).toEqual([]);
    expect(preview.json().rate).toBe("0.800000000000");
    expect(preview.json().snapshotId).toBe("snap-home-fresh");
    expect(preview.json().rateAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const who = ownerId.rows[0].id as string;
    await pool.query(
      `UPDATE ledger_till_balances SET avg_cost = NULL
        WHERE tenant_id = $1 AND till_id = 'till-01' AND currency = 'USD'`,
      [tenant],
    );
    await pool.query(
      `INSERT INTO ledger_till_balances
        (tenant_id, legal_entity_id, branch_id, workspace_id, till_id, currency, available_amount, avg_cost)
       VALUES ($1,$2,$3,$4,'till-01','EUR','50.00', 1.5)
       ON CONFLICT DO NOTHING`,
      [tenant, entity, branch, workspace],
    );
    await pool.query(
      `UPDATE ledger_till_balances SET available_amount = '50.00', avg_cost = 1.5
        WHERE tenant_id = $1 AND till_id = 'till-01' AND currency = 'EUR'`,
      [tenant],
    );
    await pool.query(
      `INSERT INTO ledger_cost_events
        (event_id, tenant_id, legal_entity_id, branch_id, location_kind, location_id,
         currency, event_kind, direction, quantity, unit_cost_home,
         quantity_before, quantity_after, source_kind, actor_id, created_at)
       VALUES ('cost-home-old',$1,$2,$3,'till','till-01','EUR','purchase','in',50,1.5,0,50,'transaction',$4,now())`,
      [tenant, entity, branch, who],
    );
    await pool.query(
      `INSERT INTO ledger_cost_lots
        (lot_id, tenant_id, legal_entity_id, branch_id, location_kind, location_id,
         currency, quantity, unit_cost_home, remaining_quantity, acquired_at, event_id)
       VALUES ('lot-home-eur',$1,$2,$3,'till','till-01','EUR',50,1.5,50,now(),'cost-home-old')`,
      [tenant, entity, branch],
    );

    const wrongPin = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-not-this",
    });
    expect(wrongPin.statusCode).toBe(422);
    expect(wrongPin.json().message).toMatch(/no longer the one you reviewed/i);
    expect(await home()).toBe("USD");

    const changed = await postChange({
      currency: "GBP",
      password: "a-strong-pass",
      snapshotId: "snap-home-fresh",
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ currency: "GBP", previous: "USD", rate: "0.800000000000" });
    expect(await home()).toBe("GBP");

    const kept = await pool.query(
      "SELECT from_currency, to_currency, input_amount, home_currency FROM ledger_transactions WHERE transaction_id='tx-home-1'",
    );
    expect(String(kept.rows[0].from_currency).trim()).toBe("USD");
    expect(String(kept.rows[0].home_currency).trim()).toBe("USD");
    expect(Number(kept.rows[0].input_amount)).toBe(100);

    const audit = await pool.query(
      `SELECT actor_id, reason, created_at FROM ledger_audit_events
        WHERE tenant_id=$1 AND action='desk.home_currency.change'`,
      [tenant],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(ownerId.rows[0].id);
    expect(audit.rows[0].created_at).toBeInstanceOf(Date);
    expect(audit.rows[0].reason).toContain("home currency USD to GBP");
    expect(audit.rows[0].reason).toContain("rate 0.800000000000 GBP per 1 USD");
    expect(audit.rows[0].reason).toContain("market rate fetched at");
    expect(audit.rows[0].reason).toContain("snap-home-fresh");
    expect(audit.rows[0].reason).toContain("report threshold 1000.00 USD to 800.00 GBP");
    expect(audit.rows[0].reason).toContain("id threshold unset");

    const usdCost = await pool.query(
      `SELECT avg_cost FROM ledger_till_balances
        WHERE tenant_id = $1 AND till_id = 'till-01' AND currency = 'USD'`,
      [tenant],
    );
    expect(new Decimal(usdCost.rows[0].avg_cost).toFixed(12)).toBe("0.800000000000");
    const eurCost = await pool.query(
      `SELECT avg_cost FROM ledger_till_balances
        WHERE tenant_id = $1 AND till_id = 'till-01' AND currency = 'EUR'`,
      [tenant],
    );
    expect(new Decimal(eurCost.rows[0].avg_cost).toFixed(12)).toBe("1.200000000000");
    const historic = await pool.query(
      "SELECT unit_cost_home FROM ledger_cost_events WHERE event_id = 'cost-home-old'",
    );
    expect(new Decimal(historic.rows[0].unit_cost_home).toFixed(1)).toBe("1.5");
    const lot = await pool.query(
      "SELECT unit_cost_home FROM ledger_cost_lots WHERE lot_id = 'lot-home-eur'",
    );
    expect(new Decimal(lot.rows[0].unit_cost_home).toFixed(12)).toBe("1.200000000000");
    const rebases = await pool.query(
      `SELECT count(*)::int AS n FROM ledger_cost_events
        WHERE tenant_id = $1 AND event_kind = 'rebase'`,
      [tenant],
    );
    expect(rebases.rows[0].n).toBeGreaterThanOrEqual(3);

    await pool.query(
      `INSERT INTO ledger_transactions
        (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
         customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
         fee_cad, spread_cad, purpose, source_of_funds, posted_at, deal_kind, received_instrument,
         disbursed_instrument, home_currency)
       VALUES ('tx-home-2','TX-HOME-2',$1,$2,$3,$4,'till-01','cust-home',$5,'GBP','USD',40,50,1.25,
               0,0,'travel','salary',now(),'exchange','cash','cash','GBP')`,
      [tenant, entity, branch, workspace, who],
    );
    const summary = await app.inject({ method: "GET", url: "/api/ledger/summary", cookies: owner() });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().volumeHome).toBe("40.00");
    expect(summary.json().otherCurrencyDeals).toBeGreaterThanOrEqual(1);
    const booked = summary.json().byHomeCurrency as { homeCurrency: string; deals: number }[];
    expect(booked.map((row) => row.homeCurrency).sort()).toEqual(expect.arrayContaining(["GBP", "USD"]));

    const beforeBoards = await pool.query(
      "SELECT count(*)::int AS n FROM rate_boards WHERE tenant_id = $1",
      [tenant],
    );
    const synced = await publishFromMarket(
      handle.db,
      { provider: "test", providerTimestamp: null, mids: { USD: 1.36, GBP: 1.7, EUR: 1.5 } },
      branch,
    );
    expect(synced).toBeNull();
    const afterBoards = await pool.query(
      "SELECT count(*)::int AS n FROM rate_boards WHERE tenant_id = $1",
      [tenant],
    );
    expect(afterBoards.rows[0].n).toBe(beforeBoards.rows[0].n);

    const afterBoard = await pool.query(
      `SELECT board_rows, home_currency FROM rate_boards
        WHERE tenant_id=$1 ORDER BY published_at DESC LIMIT 1`,
      [tenant],
    );
    expect(afterBoard.rows[0].board_rows).toEqual(beforeBoard.rows[0].board_rows);
    expect(String(afterBoard.rows[0].home_currency).trim()).toBe("USD");

    const rates = await app.inject({ method: "GET", url: "/api/rates", cookies: owner() });
    expect(rates.json().board).toBeNull();
    expect(rates.json().notice).toMatch(/priced in USD/);
    expect(rates.json().notice).toMatch(/GBP/);

    const lines = await app.inject({ method: "GET", url: "/api/ledger/desk-thresholds", cookies: owner() });
    expect(lines.json().currency).toBe("GBP");
    expect(lines.json().reportThreshold.deskChoice).toBe("800.00");
    expect(lines.json().reportThreshold.packValue).toBe("8000.00");
    expect(lines.json().idThreshold.effective).toBe("2400.00");

    const tape = await app.inject({ method: "GET", url: "/api/rates/ticker", cookies: owner() });
    expect(tape.json().home).toBe("GBP");

    const pack = await app.inject({ method: "GET", url: "/api/ledger/jurisdiction", cookies: owner() });
    expect(pack.json().pack.homeCurrency).toBe("GBP");

    const client = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies: owner(),
      payload: { legalName: "Walk In" },
    });
    expect(client.statusCode, client.body).toBe(201);
    const counter = await app.inject({
      method: "POST",
      url: `/api/clients/${client.json().clientId}/counter-record`,
      cookies: owner(),
    });
    expect(counter.statusCode, counter.body).toBe(200);
    const quote = await app.inject({
      method: "POST",
      url: "/api/quotes",
      cookies: owner(),
      payload: {
        customerId: counter.json().customerId,
        from: "GBP",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        direction: "customer_buy_foreign",
      },
    });
    expect(quote.statusCode).toBe(422);
    expect(quote.json().code).toBe("RATE_NOT_AVAILABLE");
    expect(quote.json().message).toMatch(/priced in USD/);
  });

  it("refuses a later administrator", async () => {
    const hired = await app.inject({
      method: "POST",
      url: "/api/staff",
      cookies: owner(),
      payload: { staffId: "admin.home", name: "Later Admin", role: "administrator", password: "admin-pass-1" },
    });
    expect(hired.statusCode, hired.body).toBe(201);
    const signed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "admin.home", password: "admin-pass-1", tenantId: tenant },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const session = signed.cookies.find((item) => item.name === "cdos_session")?.value;
    if (!session) throw new Error("no administrator session");
    const theirs = await app.inject({
      method: "GET",
      url: "/api/ledger/home-currency",
      cookies: { cdos_session: session },
    });
    expect(theirs.json().owner).toBe(false);
    const refused = await postChange(
      { currency: "EUR", password: "admin-pass-1", snapshotId: "snap-home-fresh" },
      session,
    );
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe("Only the owner can change the base currency.");
    expect(await home()).toBe("GBP");
    const mine = await app.inject({ method: "GET", url: "/api/ledger/home-currency", cookies: owner() });
    expect(mine.json().owner).toBe(true);
  });

  it("converts a Canada desk's lines when the book moves to EUR", async () => {
    const canadaCookie = await signup(canada.slug, canada.email, { country: "Canada" });
    const canadaEntity = `le-${canada.slug}`;
    const before = await pool.query(
      `SELECT jurisdiction_pack_id, home_currency, report_threshold, id_threshold
         FROM legal_entities WHERE id = $1`,
      [canadaEntity],
    );
    const unchanged = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: canadaCookie },
    });
    expect(unchanged.json().currency).toBe("CAD");
    expect(unchanged.json().reportThreshold.effective).toBe("10000.00");
    expect(unchanged.json().conversionRate).toBe("1.000000000000");
    expect(unchanged.json().conversionRateAt).toBeNull();
    const afterRead = await pool.query(
      `SELECT jurisdiction_pack_id, home_currency, report_threshold, id_threshold
         FROM legal_entities WHERE id = $1`,
      [canadaEntity],
    );
    expect(afterRead.rows[0]).toEqual(before.rows[0]);
    expect(String(before.rows[0].jurisdiction_pack_id)).toBe("pack-ca-v1");
    expect(String(before.rows[0].home_currency).trim()).toBe("CAD");
    expect(before.rows[0].report_threshold).toBeNull();

    const moved = await app.inject({
      method: "POST",
      url: "/api/ledger/home-currency",
      cookies: { cdos_session: canadaCookie },
      payload: { currency: "EUR", password: "a-strong-pass", snapshotId: "snap-home-fresh" },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().currency).toBe("EUR");
    const lines = await app.inject({
      method: "GET",
      url: "/api/ledger/desk-thresholds",
      cookies: { cdos_session: canadaCookie },
    });
    expect(lines.json().currency).toBe("EUR");
    expect(lines.json().reportThreshold.effective).toBe("6666.66");
    expect(lines.json().conversionRate).not.toBe("1.000000000000");

    const staff = await pool.query(
      "SELECT id FROM staff_users WHERE tenant_id = $1 ORDER BY created_at, id LIMIT 1",
      [`tnt-${canada.slug}`],
    );
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const pack = await resolvePack(client, canadaEntity);
      const stamp = await requireIdentification(
        client,
        {
          userId: String(staff.rows[0].id),
          tenantId: `tnt-${canada.slug}`,
          legalEntityId: canadaEntity,
          branchId: `br-${canada.slug}-main`,
          workspaceId: `ws-${canada.slug}-till-01`,
          tillId: "till-01",
          role: "administrator",
          authorizedBranchIds: [],
        },
        pack,
        new Decimal("10"),
        "verified",
        { kind: "exchange", cash: true },
      );
      expect(stamp.rate).toBe(lines.json().conversionRate);
      expect(stamp.rateAt).toBeInstanceOf(Date);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
