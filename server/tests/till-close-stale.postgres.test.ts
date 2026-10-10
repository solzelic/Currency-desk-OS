/* ============================================================
   A close that was counted, and then the drawer moved.

   Device A reads the book and counts it. Device B posts a deal.
   A then closes with the figures from the count. That close used
   to be accepted, and it wrote the old count back over the deal.
   The next open started from the count, and the deal was gone
   from the drawer.
   ============================================================ */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value,
  };
}

async function reset() {
  await pool.query(
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_till_balance_generations,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES
      ($1||':a.singh',$1,$2,$3,$4,$5,'teller','["br-yorkville"]'),
      ($1||':r.haddad',$1,$2,$3,$4,$5,'branch_manager','["br-yorkville"]')`,
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_customers
      (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
     VALUES ('customer-demo',$1,$2,$3,$4,'Demo Customer','normal','verified')`,
    scope.slice(0, 4),
  );
  await pool.query(
    `INSERT INTO ledger_rates VALUES
      ($1,$2,$3,$4,'CAD',1),
      ($1,$2,$3,$4,'USD',0.731),
      ($1,$2,$3,$4,'EUR',0.676),
      ($1,$2,$3,$4,'GBP',0.581)`,
    scope.slice(0, 4),
  );
  for (const [currency, value] of [
    ["CAD", 25000],
    ["USD", 12000],
    ["EUR", 7000],
    ["GBP", 3500],
  ] as const) {
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())`,
    scope,
  );
}

const book = async (cookies: Record<string, string>) =>
  (
    await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies,
    })
  ).json() as { balanceGeneration?: string; balances: Record<string, string> };

const close = (
  cookies: Record<string, string>,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/till-sessions/session-1/close",
    cookies,
    payload: body,
  });

postgres("a till close after the drawer has moved", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const real = await createDb();
    await real.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
    process.env.LEDGER_DATABASE_URL = url;
    pool = new pg.Pool({ connectionString: url });
    await runMigrations(pool);
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  it("refuses a till close when money moved after the count", async () => {
    const teller = await cookie();
    const manager = await cookie("r.haddad");
    const counted = await book(manager);

    const deal = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: teller,
      payload: {
        idempotencyKey: "deal-after-count",
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "40.00",
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Cash",
      },
    });
    expect(deal.statusCode, deal.body).toBe(201);
    const afterDeal = await book(manager);
    expect(afterDeal.balances.CAD).toBe("25040.00");

    const closed = await close(manager, {
      idempotencyKey: "close-stale",
      counts: counted.balances,
      note: "counted before the deal",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(422);
    expect(closed.json().message).toBe("Money moved since you counted. Count again.");
    expect((await book(manager)).balances).toEqual(afterDeal.balances);
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-1'",
        )
      ).rows[0].status,
    ).toBe("open");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ledger_till_count_batches WHERE count_kind='close'",
        )
      ).rows[0].n,
    ).toBe(0);

    const recounted = await book(manager);
    const accepted = await close(manager, {
      idempotencyKey: "close-fresh",
      counts: recounted.balances,
      note: "counted again",
      balanceGeneration: recounted.balanceGeneration,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().session.status).toBe("closed");
    expect((await book(manager)).balances.CAD).toBe("25040.00");
  });

  it("tells an old tab to reload when the close names no mark", async () => {
    const manager = await cookie("r.haddad");
    const counted = await book(manager);
    /* A tab opened before this mark existed posts the close it always
       posted: the counts, and no balanceGeneration. That used to come
       back as a bare validation code. */
    const closed = await close(manager, {
      idempotencyKey: "close-no-mark",
      counts: counted.balances,
      note: "opened before the mark existed",
    });
    expect(closed.statusCode, closed.body).toBe(422);
    expect(closed.json().message).toBe(
      "The desk was updated. Reload, then count again.",
    );
    expect((await book(manager)).balances).toEqual(counted.balances);
    expect(
      (
        await pool.query(
          "SELECT status FROM ledger_till_sessions WHERE session_id='session-1'",
        )
      ).rows[0].status,
    ).toBe("open");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ledger_till_count_batches WHERE count_kind='close'",
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("still closes when nothing moved after the count", async () => {
    const manager = await cookie("r.haddad");
    const counted = await book(manager);
    const closed = await close(manager, {
      idempotencyKey: "close-quiet",
      counts: counted.balances,
      note: "quiet close",
      balanceGeneration: counted.balanceGeneration,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().session.status).toBe("closed");
    expect((await book(manager)).balances).toEqual(counted.balances);
  });
});
