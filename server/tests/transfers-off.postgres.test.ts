/* ============================================================
   Transfers are off for a real shop until transfer records are kept
   on the server (CD-111, GitHub #599).

   Transfers (EFT) live only in each browser's local storage today, so
   a real shop must not be able to send or receive one: a wire with no
   server record is a wire nobody can report. The server refuses both
   remittance routes with 422 TRANSFERS_NOT_AVAILABLE before financial
   or idempotency writes, for every role. Each refused attempt is audited,
   including a replay of the same key. A test shop (the staging demo, a sign-up on
   the staging door, this harness) keeps them. Settling an obligation a
   test shop already made is not a transfer, and still works once the
   shop is real again. Hiding the menu alone does not pass.
   ============================================================ */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, markTestShop, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;
const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

async function cookie(staffId = "r.haddad") {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });
  return { cdos_session: login.cookies.find((c) => c.name === "cdos_session")!.value };
}

/* The same desk the reporting tests stand on: one branch, one open
   till, one verified customer, a rate for the dollar. Every shop is a
   real shop unless something marks it, and reset() makes sure of it. */
async function reset() {
  await handle.db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, "transfer.refused_real_shop"));
  await pool.query(
    "TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals,ledger_obligations,rate_boards,market_rates CASCADE",
  );
  await pool.query("INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query("INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING", [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId]);
  for (const [staffId, role] of [["j.masri", "administrator"], ["r.haddad", "branch_manager"], ["m.costa", "teller"]]) {
    await pool.query(
      `INSERT INTO ledger_principals (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
       VALUES ($1||':'||$6,$1,$2,$3,$4,$5,$7,'["br-yorkville"]')`,
      [...scope, staffId, role],
    );
  }
  await pool.query("INSERT INTO ledger_customers VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','Normal','verified')", scope.slice(0, 4));
  await pool.query(
    `INSERT INTO ledger_till_sessions (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,session_number,business_date,status,opened_by,opened_at)
     VALUES ('transfers-session',$1,$2,$3,$4,$5,1,current_date,'open',$1||':r.haddad',now())`,
    scope,
  );
  await pool.query("INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.714285714286)", scope.slice(0, 4));
  await pool.query("INSERT INTO market_rates (id,provider,mids,fetched_at) VALUES ('transfers-snap','test','{\"USD\":1.4}',now())");
  await pool.query(
    `INSERT INTO rate_boards (id,tenant_id,legal_entity_id,branch_id,buy_margin,sell_margin,board_rows,market_snapshot_id,published_at)
     VALUES ('transfers-board',$1,$2,$3,0.02,0.03,'{"USD":{"mid":1.4,"show":true}}','transfers-snap',now())`,
    scope.slice(0, 3),
  );
  await pool.query(
    `INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount,avg_cost)
     VALUES ($1,$2,$3,$4,$5,'CAD',20000,NULL)`,
    scope,
  );
  await markTestShop(handle.db, DEMO.tenantId, false);
}

const send = async (key: string, staffId = "r.haddad") => app.inject({
  method: "POST", url: "/api/ledger/remittances/send", cookies: await cookie(staffId),
  payload: {
    idempotencyKey: key, customerId: "customer-demo", reference: key,
    principalAmount: "100.00", feeAmount: "5.00", payoutCurrency: "USD", payoutAmount: "70.00",
    corridor: "US", partner: "Wire partner", beneficiaryName: "A Beneficiary",
    purpose: "Family support", sourceOfFunds: "Salary",
  },
});
const receive = async (key: string) => app.inject({
  method: "POST", url: "/api/ledger/remittances/receive", cookies: await cookie(),
  payload: {
    idempotencyKey: key, customerId: "customer-demo", reference: key,
    sentCurrency: "USD", sentAmount: "100.00", payoutAmount: "130.00", feeAmount: "0.00",
    corridor: "US", partner: "Wire partner", purpose: "Family support", sourceOfFunds: "Salary",
  },
});
/* Rows the two routes would write. After reset() every one is empty. */
async function stored() {
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return { transactions: await count("ledger_transactions"), obligations: await count("ledger_obligations"), idempotency: await count("ledger_idempotency") };
}
const NOTHING = { transactions: 0, obligations: 0, idempotency: 0 };
const refusals = () => handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "transfer.refused_real_shop"));

postgres("transfers are off for a real shop", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    process.env.SEED_PASSWORD = "yorkville";
    pool = new pg.Pool({ connectionString: url });
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });
  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
  });
  beforeEach(reset);

  it("refuses a send with 422, records the audit, and stores no financial rows", async () => {
    const res = await send("send-real-1");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe("TRANSFERS_NOT_AVAILABLE");
    expect(res.json().message).toMatch(/transfer/i);
    expect(await stored()).toEqual(NOTHING);
    expect(await refusals()).toMatchObject([{
      tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId,
      actorId: `${DEMO.tenantId}:r.haddad`,
      detail: { route: "/api/ledger/remittances/send", idempotencyKey: "send-real-1" },
    }]);
  });

  it("refuses a receive the same way", async () => {
    const res = await receive("receive-real-1");
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe("TRANSFERS_NOT_AVAILABLE");
    expect(await stored()).toEqual(NOTHING);
    expect(await refusals()).toMatchObject([{
      tenantId: DEMO.tenantId, actorId: `${DEMO.tenantId}:r.haddad`,
      detail: { route: "/api/ledger/remittances/receive", idempotencyKey: "receive-real-1" },
    }]);
  });

  it.each(["j.masri", "r.haddad", "m.costa"])("refuses %s too: no role is let through", async (staffId) => {
    const res = await send(`send-${staffId}`, staffId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().code).toBe("TRANSFERS_NOT_AVAILABLE");
    expect(await refusals()).toMatchObject([{ actorId: `${DEMO.tenantId}:${staffId}` }]);
  });

  it("refuses a replay of the same key, and still stores nothing", async () => {
    expect((await send("send-replay")).statusCode).toBe(422);
    const again = await send("send-replay");
    expect(again.statusCode, again.body).toBe(422);
    expect(again.json().code).toBe("TRANSFERS_NOT_AVAILABLE");
    expect(await stored()).toEqual(NOTHING);
    expect(await refusals()).toHaveLength(2);
  });

  it("lets a test shop send and receive, as today", async () => {
    await markTestShop(handle.db);
    const sent = await send("send-test-1");
    expect(sent.statusCode, sent.body).toBe(201);
    const got = await receive("receive-test-1");
    expect(got.statusCode, got.body).toBe(201);
    expect((await stored()).transactions).toBe(2);
    expect(await refusals()).toHaveLength(0);
  });

  it("still settles an obligation a test shop made, after the shop is real again", async () => {
    await markTestShop(handle.db);
    const sent = await send("send-then-settle");
    expect(sent.statusCode, sent.body).toBe(201);
    const obligationId = sent.json().obligationId as string;
    expect(obligationId).toMatch(/^obl_/);
    await markTestShop(handle.db, DEMO.tenantId, false);
    const settled = await app.inject({
      method: "POST", url: `/api/ledger/obligations/${obligationId}/settlement`, cookies: await cookie(),
      payload: { idempotencyKey: "settle-after", amountHome: "1.00", reference: "partner paid" },
    });
    expect(settled.statusCode, settled.body).toBe(201);
  });
});
