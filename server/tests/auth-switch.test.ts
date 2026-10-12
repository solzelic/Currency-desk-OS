/* Switching accounts used to rename the screen and leave the cookie.
   A deal posted after that still carried the person who typed the
   password. These tests are the old behaviour going red: the switch
   is a new session, and the book stamps that session. */
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

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
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
  await app.close();
  await handle.close();
  await pool?.end();
  delete process.env.LEDGER_DATABASE_URL;
});

describe("account switch refuses a PIN the server does not hold", () => {
  it("refuses a person who has no PIN, and does not treat 0000 as one", async () => {
    const costa = await login(A);
    const missing = await switchTo(costa, "r.haddad", "1357");
    expect(missing.statusCode, missing.body).toBe(409);
    expect(missing.json()).toMatchObject({ error: "no_pin" });
    expect(missing.json().detail).toMatch(/No PIN is set/);

    await setPin("s.iqbal", "0000");
    const placeholder = await switchTo(costa, "s.iqbal", "0000");
    expect(placeholder.statusCode, placeholder.body).toBe(401);
    expect(placeholder.json().error).toBe("wrong_pin");
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
    expect(other.statusCode, other.body).toBe(403);
    expect(other.json().error).toBe("cross_tenant");
    const missing = await switchTo(costa, "nobody.here", "1357");
    expect(missing.statusCode).toBe(404);
  });

  it("locks the keypad the same way a PIN check does", async () => {
    await setPin("r.haddad", "4829");
    const costa = await login(A);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await switchTo(costa, "r.haddad", "1357")).statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.at(-1)).toBe(429);
    clearPinAttempts(idOf("r.haddad"));
  });
});

describe("account switch replaces the session", () => {
  it("keeps the till when the next person may use it, and kills the old cookie", async () => {
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
      payload: { name: `Walk-in ${key}`, risk: "normal", idStatus: "verified" },
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

  it("stamps B on the deal, the audit and the till, then A on the way back", async () => {
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

    const toCosta = await switchTo(singh, A, "1357");
    expect(toCosta.statusCode, toCosta.body).toBe(200);
    const back = cookieOf(toCosta);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: singh })).statusCode).toBe(401);
    const second = await postDeal(back, "switch-a", idOf(B));
    const reverse = await pool!.query(
      "SELECT actor_id FROM ledger_transactions WHERE transaction_id=$1",
      [second],
    );
    expect(reverse.rows[0].actor_id).toBe(idOf(A));
    const still = await pool!.query("SELECT opened_by FROM ledger_till_sessions WHERE status='open'");
    expect(still.rows.map((row) => row.opened_by)).toEqual([idOf(B)]);
  });
});
