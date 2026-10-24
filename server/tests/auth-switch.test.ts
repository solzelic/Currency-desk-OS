/* Switching accounts used to rename the screen and leave the cookie.
   A deal posted after that still carried the person who typed the
   password. These tests are the old behaviour going red: the switch
   is a new session, and the book stamps that session. */
import { readFileSync } from "node:fs";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPin, clearPinAttempts } from "../src/routes/pin.js";
import { setSessionWorkspace } from "../src/auth/sessions.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let handle: DbHandle;
let app: FastifyInstance;
let pool: pg.Pool | undefined;

const A = "m.costa";
const B = "a.singh";
const idOf = (staffId: string) => `${DEMO.tenantId}:${staffId}`;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("sign-in did not set a session cookie");
  return { cdos_session: c.value };
};
const login = async (staffId: string) => {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return cookieOf(res);
};
const setPin = async (staffId: string, pin: string) => {
  await handle.db.update(schema.staffUsers).set({
    pinHash: await hashPin(pin), pinSetAt: new Date(), pinMustChange: false,
  }).where(eq(schema.staffUsers.id, idOf(staffId)));
  clearPinAttempts(idOf(staffId));
};
const switchTo = (cookies: Record<string, string>, staffId: string, pin: string) =>
  app.inject({ method: "POST", url: "/api/auth/switch", cookies, payload: { staffId, pin } });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  if (url) {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
  }
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  if (pool) {
    await pool.query("DELETE FROM staff_users WHERE password_hash='x' AND id LIKE 'tnt-yorkfx:%'");
  }
  await app.close();
  await handle.close();
  await pool?.end();
  delete process.env.LEDGER_DATABASE_URL;
});

describe("account switch refuses a PIN the server does not hold", () => {
  it("refuses a person who has no PIN, and does not treat 0000 as one", async () => {
    const costa = await login(A);
    const missing = await switchTo(costa, B, "1357");
    expect(missing.statusCode, missing.body).toBe(409);
    expect(missing.json()).toEqual({
      error: "no_pin",
      detail: "A.\u00A0Singh has no PIN yet. They need to choose their own PIN before switching in.",
    });

    await handle.db.update(schema.staffUsers).set({ name: "Amrit Singh" }).where(eq(schema.staffUsers.id, idOf(B)));
    try {
      const full = await switchTo(costa, B, "1357");
      expect(full.statusCode, full.body).toBe(409);
      expect(full.json().detail).toBe("A.\u00A0Singh has no PIN yet. They need to choose their own PIN before switching in.");
    } finally {
      await handle.db.update(schema.staffUsers).set({ name: "A. Singh" }).where(eq(schema.staffUsers.id, idOf(B)));
    }

    await setPin("s.iqbal", "0000");
    const placeholder = await switchTo(costa, "s.iqbal", "0000");
    expect(placeholder.statusCode, placeholder.body).toBe(422);
    expect(placeholder.json()).toEqual({
      error: "weak_pin",
      detail: "0000 is too easy to guess. Pick a different PIN.",
    });
    const again = await switchTo(costa, "s.iqbal", "0000");
    expect(again.statusCode, again.body).toBe(422);
    const still = await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa });
    expect(still.statusCode).toBe(200);
    expect(still.json().user.id).toBe(A);
  });

  it("refuses somebody on another desk", async () => {
    await handle.db.insert(schema.tenants).values({ id: "tnt-other", name: "Other Desk" });
    await handle.db.insert(schema.legalEntities).values({
      id: "le-other", tenantId: "tnt-other", name: "Other Inc.",
    });
    await handle.db.insert(schema.branches).values({
      id: "br-other", tenantId: "tnt-other", legalEntityId: "le-other", name: "Other",
    });
    await handle.db.insert(schema.staffUsers).values({
      id: "tnt-other:x.ade", tenantId: "tnt-other", legalEntityId: "le-other", branchId: "br-other",
      staffId: "x.ade", name: "X. Ade", role: "teller", authorizedBranchIds: ["br-other"],
      passwordHash: "unused",
    });
    const costa = await login(A);
    const other = await switchTo(costa, "x.ade", "1357");
    const missing = await switchTo(costa, "nobody.here", "1357");
    expect(other.statusCode, other.body).toBe(404);
    expect(missing.statusCode, missing.body).toBe(404);
    expect(other.json()).toEqual(missing.json());
    expect(other.json()).toEqual({ error: "not_found", detail: "That person is not on this desk." });
  });

  it("refuses a manager-issued PIN until that person chooses their own", async () => {
    await handle.db.update(schema.staffUsers).set({
      pinHash: await hashPin("4829"), pinSetAt: new Date(), pinMustChange: true,
    }).where(eq(schema.staffUsers.id, idOf("s.iqbal")));
    const costa = await login(A);
    const refused = await switchTo(costa, "s.iqbal", "4829");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toEqual({
      error: "must_change",
      detail: "S.\u00A0Iqbal needs to choose their own PIN before switching in.",
    });
    const still = await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa });
    expect(still.json().user.id).toBe(A);
  });

  it("locks the keypad the same way a PIN check does", async () => {
    await setPin(B, "4829");
    const costa = await login(A);
    const tries = [];
    for (let i = 0; i < 5; i++) tries.push(await switchTo(costa, B, "1111"));
    expect(tries.map((res) => res.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(tries[4]!.json()).toMatchObject({
      error: "wrong_pin",
      locked: true,
      detail: "Too many wrong tries. This clears on its own in 5 minutes.",
    });
    const locked = await switchTo(costa, B, "1111");
    expect(locked.statusCode, locked.body).toBe(429);
    expect(locked.json()).toEqual({
      error: "locked",
      detail: "Too many wrong tries. This clears on its own in 5 minutes.",
    });
    const weakWhileLocked = await switchTo(costa, B, "0000");
    expect(weakWhileLocked.statusCode, weakWhileLocked.body).toBe(429);
    expect(weakWhileLocked.json().detail).toBe("Too many wrong tries. This clears on its own in 5 minutes.");
    clearPinAttempts(idOf(B));
  });
});

describe("handover says a network failure in plain words", () => {
  it("never repeats the browser's fetch error", () => {
    const src = readFileSync(new URL("../../os-src/cdos-signin.jsx", import.meta.url), "utf8");
    const start = src.indexOf("function Handover");
    const body = src.slice(start, src.indexOf("function ", start + 10));
    expect(body).toContain("Could not reach the desk to switch accounts.");
    expect(body).not.toContain("e.message");
    expect(body).not.toContain("Failed to fetch");
  });
});

describe("account switch replaces the session", () => {
  it("keeps the till when nobody else has counted it, and kills the old cookie", async () => {
    if (pool) {
      await pool.query(
        `UPDATE ledger_till_sessions SET status='closed', closed_at=COALESCE(closed_at, now()), closed_by=COALESCE(closed_by, opened_by)
          WHERE workspace_id=$1 AND status='open'`,
        [DEMO.workspaceId],
      );
    }
    await setPin(B, "4829");
    const costa = await login(A);
    const switched = await switchTo(costa, B, "4829");
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({
      ok: true, pickTill: false, workspaceId: DEMO.workspaceId,
      user: { id: B, role: "supervisor" },
    });
    const next = cookieOf(switched);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: next });
    expect(me.json().user).toMatchObject({ id: B, role: "supervisor" });
    const old = await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa });
    expect(old.statusCode).toBe(401);

    const row = (await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.switch")))
      .find((event) => (event.detail as { to?: string }).to === idOf(B));
    expect(row).toMatchObject({ actorId: idOf(B), detail: { from: idOf(A), to: idOf(B) } });
  });

  it("makes them pick a till when this drawer is not theirs", async () => {
    await handle.db.insert(schema.branches).values({
      id: "br-switch-away", tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, name: "Away",
    }).onConflictDoNothing();
    await handle.db.insert(schema.workspaces).values({
      id: "ws-switch-away", tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId,
      branchId: "br-switch-away", tillId: "till-away",
    }).onConflictDoNothing();
    await setPin(B, "4829");
    const costa = await login(A);
    const token = costa.cdos_session;
    expect(token).toBeTruthy();
    await setSessionWorkspace(handle.db, token!, "ws-switch-away");
    const switched = await switchTo(costa, B, "4829");
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ ok: true, pickTill: true, workspaceId: null, user: { id: B } });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa })).statusCode).toBe(401);
  });

  it("lets one of two switches from the same cookie win", async () => {
    await setPin(B, "4829");
    const costa = await login(A);
    const [left, right] = await Promise.all([
      switchTo(costa, B, "4829"),
      switchTo(costa, B, "4829"),
    ]);
    const codes = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(codes, `${left.body} ${right.body}`).toEqual([200, 409]);
    const winner = left.statusCode === 200 ? left : right;
    const loser = left.statusCode === 409 ? left : right;
    expect(loser.json().error).toBe("session_replaced");
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: cookieOf(winner) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa })).statusCode).toBe(401);
  });
});

postgres("a switched session is the person on the deal", () => {
  const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId];

  beforeAll(async () => {
    await pool!.query("TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,rate_boards,market_rates CASCADE");
    await pool!.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
    await pool!.query(
      `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
       VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
       ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await pool!.query(
      "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
      [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool!.query(
      `INSERT INTO staff_users (id,tenant_id,legal_entity_id,branch_id,staff_id,name,role,authorized_branch_ids,password_hash)
       VALUES ($1,$2,$3,$4,'a.singh','A. Singh','supervisor','[]'::jsonb,'x'),
              ($5,$2,$3,$4,'m.costa','M. Costa','teller','[]'::jsonb,'x')
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`,
      [idOf(B), DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, idOf(A)],
    );
    await pool!.query("INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('switch-snap','test','{\"USD\":1.4}',now())");
    await pool!.query(
      "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.714285714286)",
      scope,
    );
    await pool!.query(
      `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
       VALUES ('switch-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','switch-snap',now())`,
      scope.slice(0, 3),
    );
  });

  async function postDeal(cookies: Record<string, string>, key: string, claimedActor: string) {
    const customer = await app.inject({
      method: "POST", url: "/api/ledger/customers", cookies,
      payload: { name: `Walk-in ${key}`, risk: "normal" },
    });
    expect(customer.statusCode, customer.body).toBe(201);
    const quote = await app.inject({
      method: "POST", url: "/api/quotes", cookies,
      payload: {
        customerId: customer.json().customerId, from: "CAD", to: "USD",
        inputAmount: "200.00", feeCad: "4.00", direction: "customer_buy_foreign",
      },
    });
    expect(quote.statusCode, quote.body).toBe(201);
    const posted = await app.inject({
      method: "POST", url: `/api/quotes/${quote.json().quoteId}/post`, cookies,
      payload: {
        idempotencyKey: key, purpose: "Personal travel", sourceOfFunds: "Employment income",
        actorId: claimedActor,
      },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    return posted.json().transactionId as string;
  }

  it("stamps the person who counted the till, and refuses a deal until the next person counts it", async () => {
    await setPin(B, "4829");
    await setPin(A, "1357");
    const costa = await login(A);
    const toSingh = await switchTo(costa, B, "4829");
    expect(toSingh.statusCode, toSingh.body).toBe(200);
    const singh = cookieOf(toSingh);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: costa })).statusCode).toBe(401);

    const opening = await app.inject({
      method: "POST", url: "/api/ledger/opening-balances", cookies: singh,
      payload: { balances: { CAD: "50000.00", USD: "4000.00" } },
    });
    expect(opening.statusCode, opening.body).toBe(201);
    const opened = await app.inject({ method: "POST", url: "/api/ledger/till-sessions/open", cookies: singh });
    expect(opened.statusCode, opened.body).toBe(201);
    expect(opened.json().session.openedBy).toBe(idOf(B));
    const midday = await app.inject({
      method: "POST", url: "/api/ledger/till-counts", cookies: singh,
      payload: { idempotencyKey: "singh-midday", counts: { CAD: "50000.00" } },
    });
    expect(midday.statusCode, midday.body).toBe(201);
    expect(midday.json().latestCounts.CAD.expected).toBe("50000.00");

    const first = await postDeal(singh, "switch-b", idOf(A));
    const deal = await pool!.query(
      "SELECT actor_id, compliance_captured_by FROM ledger_transactions WHERE transaction_id=$1",
      [first],
    );
    expect(deal.rows[0]).toEqual({ actor_id: idOf(B), compliance_captured_by: idOf(B) });
    const book = await pool!.query(
      "SELECT actor_id FROM ledger_audit_events WHERE action='transaction.post' AND target_id=$1",
      [first],
    );
    expect(book.rows[0].actor_id).toBe(idOf(B));
    const till = await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(till.rows.map((row) => row.opened_by)).toEqual([idOf(B)]);

    await setPin("r.haddad", "2468");
    const toManager = await switchTo(singh, "r.haddad", "2468");
    expect(toManager.statusCode, toManager.body).toBe(200);
    expect(toManager.json()).toMatchObject({
      pickTill: false, workspaceId: DEMO.workspaceId, user: { id: "r.haddad" },
    });
    const manager = cookieOf(toManager);
    const look = await app.inject({
      method: "POST", url: "/api/ledger/customers", cookies: manager,
      payload: { name: "Manager look", risk: "normal" },
    });
    expect(look.statusCode, look.body).toBe(201);
    const lookQuote = await app.inject({
      method: "POST", url: "/api/quotes", cookies: manager,
      payload: {
        customerId: look.json().customerId, from: "CAD", to: "USD",
        inputAmount: "100.00", feeCad: "4.00", direction: "customer_buy_foreign",
      },
    });
    expect(lookQuote.statusCode, lookQuote.body).toBe(201);
    const lookPost = await app.inject({
      method: "POST", url: `/api/quotes/${lookQuote.json().quoteId}/post`, cookies: manager,
      payload: { idempotencyKey: "switch-manager", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(lookPost.statusCode, lookPost.body).toBe(409);
    expect(lookPost.json().message).toBe("Count the till to take it over from A.\u00A0Singh.");
    expect((await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'")).rows.map((row) => row.opened_by)).toEqual([idOf(B)]);

    const cad = () => pool!.query(
      "SELECT available_amount FROM ledger_till_balances WHERE workspace_id=$1 AND currency='CAD'",
      [DEMO.workspaceId],
    ).then((result) => result.rows[0].available_amount as string);
    const beforeCash = await cad();
    const move = (cookies: Record<string, string>, key: string, direction: "in" | "out") => app.inject({
      method: "POST", url: "/api/ledger/till-movements", cookies,
      payload: {
        idempotencyKey: key, direction, currency: "CAD", amount: "100.00",
        counterpartyType: "bank", counterpartyRef: "qa", reason: "Not this person's till",
      },
    });
    const managerOut = await move(manager, "mgr-out", "out");
    const managerIn = await move(manager, "mgr-in", "in");
    expect(managerOut.statusCode, managerOut.body).toBe(409);
    expect(managerIn.statusCode, managerIn.body).toBe(409);
    expect(managerOut.json()).toEqual({
      code: "TILL_HELD", message: "Count the till to take it over from A.\u00A0Singh.",
    });
    expect(managerIn.json().message).toBe("Count the till to take it over from A.\u00A0Singh.");
    await setPin("j.masri", "9753");
    const toAdmin = await switchTo(manager, "j.masri", "9753");
    expect(toAdmin.statusCode, toAdmin.body).toBe(200);
    const adminOut = await move(cookieOf(toAdmin), "admin-out", "out");
    expect(adminOut.statusCode, adminOut.body).toBe(409);
    expect(adminOut.json().message).toBe("Count the till to take it over from A.\u00A0Singh.");
    expect(await cad()).toBe(beforeCash);

    const toCosta = await switchTo(cookieOf(toAdmin), A, "1357");
    expect(toCosta.statusCode, toCosta.body).toBe(200);
    expect(toCosta.json()).toMatchObject({ pickTill: true, workspaceId: null, user: { id: A } });
    const back = cookieOf(toCosta);
    const heldQuote = await app.inject({
      method: "POST", url: "/api/quotes", cookies: back,
      headers: { "x-workspace-id": DEMO.workspaceId },
      payload: {
        customerId: look.json().customerId, from: "CAD", to: "USD",
        inputAmount: "100.00", feeCad: "4.00", direction: "customer_buy_foreign",
      },
    });
    expect(heldQuote.statusCode, heldQuote.body).toBe(201);
    const held = await app.inject({
      method: "POST", url: `/api/quotes/${heldQuote.json().quoteId}/post`, cookies: back,
      headers: { "x-workspace-id": DEMO.workspaceId },
      payload: { idempotencyKey: "switch-held", purpose: "Personal travel", sourceOfFunds: "Employment income" },
    });
    expect(held.statusCode, held.body).toBe(409);
    expect(held.json()).toEqual({
      code: "TILL_HELD",
      message: "Count the till to take it over from A.\u00A0Singh.",
    });
    const openBefore = await pool!.query("SELECT session_id, opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(openBefore.rows.map((row) => row.opened_by)).toEqual([idOf(B)]);

    await setPin("s.iqbal", "8642");
    const toIqbal = await switchTo(back, "s.iqbal", "8642");
    expect(toIqbal.statusCode, toIqbal.body).toBe(200);
    const iqbal = cookieOf(toIqbal);
    const headers = { "x-workspace-id": DEMO.workspaceId };
    const preview = await app.inject({
      method: "GET", url: "/api/ledger/till-session", cookies: iqbal, headers,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(JSON.stringify(preview.json())).not.toContain('"expected"');
    const refusedCount = await app.inject({
      method: "POST", url: "/api/ledger/till-counts", cookies: iqbal, headers,
      payload: { idempotencyKey: "iqbal-midday", counts: { CAD: "1.00" } },
    });
    expect(refusedCount.statusCode, refusedCount.body).toBe(409);
    expect(refusedCount.json()).toEqual({
      code: "TILL_HELD", message: "Count the till to take it over from A.\u00A0Singh.",
    });
    expect(JSON.stringify(refusedCount.json())).not.toContain("expected");

    const handover = await app.inject({
      method: "POST", url: "/api/ledger/till-sessions/handover", cookies: iqbal, headers,
      payload: { idempotencyKey: "handover-iqbal", counts: { CAD: "50000.00", USD: "4000.00" } },
    });
    expect(handover.statusCode, handover.body).toBe(201);
    expect(handover.json().session.openedBy).toBe(idOf("s.iqbal"));
    expect(JSON.stringify(handover.json())).not.toContain('"expected"');
    const closed = await pool!.query(
      "SELECT status, opened_by, closed_by FROM ledger_till_sessions WHERE session_id=$1",
      [openBefore.rows[0].session_id],
    );
    expect(closed.rows[0]).toMatchObject({
      status: "closed", opened_by: idOf(B), closed_by: idOf("s.iqbal"),
    });
    const variance = await pool!.query(
      "SELECT actor_id FROM ledger_till_count_batches WHERE session_id=$1 AND count_kind='close'",
      [openBefore.rows[0].session_id],
    );
    expect(variance.rows.map((row) => row.actor_id)).toEqual([idOf("s.iqbal")]);
    const lines = await pool!.query(
      `SELECT c.variance_amount
         FROM ledger_till_counts c
         JOIN ledger_till_count_batches b ON b.batch_id = c.batch_id
        WHERE b.session_id=$1 AND b.count_kind='close'`,
      [openBefore.rows[0].session_id],
    );
    expect(lines.rows.length).toBeGreaterThan(0);

    const second = await postDeal(iqbal, "switch-iqbal", idOf(B));
    const reverse = await pool!.query("SELECT actor_id FROM ledger_transactions WHERE transaction_id=$1", [second]);
    expect(reverse.rows[0].actor_id).toBe(idOf("s.iqbal"));
    const openNow = await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(openNow.rows.map((row) => row.opened_by)).toEqual([idOf("s.iqbal")]);
  });

  it("an exchange records the switched session, not a poster named in the body", async () => {
    await setPin(B, "4829");
    await setPin("s.iqbal", "8642");
    const singh = await login(B);
    const headers = { "x-workspace-id": DEMO.workspaceId };
    const open = await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    if (!open.rows.length) {
      const opening = await app.inject({
        method: "POST", url: "/api/ledger/opening-balances", cookies: singh,
        payload: { balances: { CAD: "50000.00", USD: "4000.00" } },
      });
      expect(opening.statusCode, opening.body).toBe(201);
      const opened = await app.inject({
        method: "POST", url: "/api/ledger/till-sessions/open", cookies: singh,
      });
      expect(opened.statusCode, opened.body).toBe(201);
    }
    const switched = await switchTo(singh, "s.iqbal", "8642");
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json().user.id).toBe("s.iqbal");
    const iqbal = cookieOf(switched);
    const holder = await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    if (holder.rows[0]?.opened_by !== idOf("s.iqbal")) {
      const counts = await pool!.query(
        "SELECT currency, available_amount FROM ledger_till_balances WHERE workspace_id=$1",
        [DEMO.workspaceId],
      );
      const handover = await app.inject({
        method: "POST", url: "/api/ledger/till-sessions/handover", cookies: iqbal, headers,
        payload: {
          idempotencyKey: "exchange-handover-iqbal",
          counts: Object.fromEntries(counts.rows.map((row) => [row.currency, row.available_amount])),
        },
      });
      expect(handover.statusCode, handover.body).toBe(201);
    }
    const customer = await app.inject({
      method: "POST", url: "/api/ledger/customers", cookies: iqbal, headers,
      payload: { name: "Exchange switch", risk: "normal" },
    });
    expect(customer.statusCode, customer.body).toBe(201);
    const posted = await app.inject({
      method: "POST", url: "/api/ledger/exchanges", cookies: iqbal, headers,
      payload: {
        idempotencyKey: "exchange-switch-iqbal",
        customerId: customer.json().customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "4.00",
        purpose: "Personal travel",
        sourceOfFunds: "Employment income",
        actorId: idOf(B),
        complianceCapturedBy: idOf(B),
      },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const row = await pool!.query(
      "SELECT actor_id, compliance_captured_by FROM ledger_transactions WHERE transaction_id=$1",
      [posted.json().transactionId],
    );
    expect(row.rows[0]).toEqual({
      actor_id: idOf("s.iqbal"),
      compliance_captured_by: idOf("s.iqbal"),
    });
  });
});
