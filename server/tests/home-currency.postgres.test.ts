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
import { setSanctionedCurrencyLookup } from "../src/compliance/sanctioned-currencies.js";

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
    return app.inject({
      method: "POST",
      url: "/api/ledger/home-currency",
      cookies: { cdos_session: session },
      payload: body,
    });
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
    expect(wrong.statusCode).toBe(401);
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
    await pool.query("UPDATE market_rates SET fetched_at = now() - interval '25 hours'");
    const stale = await postChange({ currency: "GBP", password: "a-strong-pass" });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().code).toBe("HOME_RATE_UNAVAILABLE");
    expect(stale.json().message).toMatch(/24 hours/i);

    await pool.query("DELETE FROM market_rates");
    const missing = await postChange({ currency: "GBP", password: "a-strong-pass" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe("HOME_RATE_UNAVAILABLE");

    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-home-partial', 'test', '{"USD":1.36}'::jsonb, now())`,
    );
    const unpriced = await postChange({ currency: "GBP", password: "a-strong-pass" });
    expect(unpriced.statusCode).toBe(422);
    expect(unpriced.json().code).toBe("HOME_RATE_UNAVAILABLE");
    expect(unpriced.json().message).toMatch(/GBP/);
    expect(await home()).toBe("USD");
  });

  it("keeps the ledger, writes the audit row, and the desk follows GBP", async () => {
    await pool.query(
      `INSERT INTO market_rates (id, provider, mids, fetched_at)
       VALUES ('snap-home-fresh', 'test', $1::jsonb, now())`,
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
    expect(preview.json().willNotChange.join(" ")).toMatch(/not rewritten|keep the currency/i);
    expect(preview.json().blockers).toEqual([]);
    expect(preview.json().rate).toBe("0.800000000000");

    const changed = await postChange({ currency: "GBP", password: "a-strong-pass" });
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

  it("converts a Canada desk's lines when the book moves to EUR", async () => {
    const canadaCookie = await signup(canada.slug, canada.email, { country: "Canada" });
    const moved = await app.inject({
      method: "POST",
      url: "/api/ledger/home-currency",
      cookies: { cdos_session: canadaCookie },
      payload: { currency: "EUR", password: "a-strong-pass" },
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
  });
});
