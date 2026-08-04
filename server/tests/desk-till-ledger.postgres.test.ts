/* ============================================================
   A till created from the desk is a till the book can post at.

   This is the half of the "Add till" defect that a schema check cannot
   see. The row landing in `workspaces` is necessary and not sufficient:
   the ledger scopes rates, customers, balances and sessions to a
   workspace, so a till that appears everywhere on screen can still be
   one where every deal fails. So this test does the whole thing against
   real PostgreSQL — open a location, put a till in it, hire somebody
   who works there, and book an exchange at their drawer.

   Real Postgres because the ledger is raw SQL against it, and one
   database for both halves because that is how the product deploys
   (LEDGER_DATABASE_URL falls back to DATABASE_URL).
   ============================================================ */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let pool: pg.Pool;
let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const login = async (staffId: string, password = DEMO.password) => {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password, tenantId: DEMO.tenantId } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
};

postgres("a new till can take a customer", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await pool.query(
      "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
    );
    /* Whatever a previous run of this file opened. The seeded desk stays. */
    await pool.query("DELETE FROM sessions WHERE user_id LIKE $1", [`${DEMO.tenantId}:%`]);
    await pool.query("DELETE FROM staff_users WHERE tenant_id=$1 AND branch_id<>$2", [DEMO.tenantId, DEMO.branchId]);
    await pool.query("DELETE FROM rate_boards WHERE tenant_id=$1 AND branch_id<>$2", [DEMO.tenantId, DEMO.branchId]);
    await pool.query("DELETE FROM workspaces WHERE tenant_id=$1 AND id<>$2", [DEMO.tenantId, DEMO.workspaceId]);
    await pool.query("DELETE FROM branches WHERE tenant_id=$1 AND id<>$2", [DEMO.tenantId, DEMO.branchId]);

    await seed(handle.db);
    // the seed leaves an existing account alone, and an earlier file may have
    // moved this one — the owner has to be the owner for any of this to run
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "administrator", authorizedBranchIds: [DEMO.branchId] })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:j.masri`));

    /* The prices the desk already trades at, on the till it already has.
       The new one is expected to open on these. */
    for (const [currency, perCad] of [["CAD", 1], ["USD", 0.731], ["EUR", 0.676], ["GBP", 0.581]] as const) {
      await pool.query("INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
        DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, currency, perCad,
      ]);
    }

    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  it("posts an exchange at a till that did not exist a moment ago", async () => {
    const owner = await login("j.masri");

    const till = await app.inject({
      method: "POST", url: `/api/desk/branches/${DEMO.branchId}/tills`, cookies: owner,
      payload: { tillId: "till-11" },
    });
    expect(till.statusCode).toBe(201);
    const workspaceId = till.json().workspaceId as string;

    // the new drawer opens on the same prices as the one beside it — without
    // this the first deal dies with RATE_NOT_AVAILABLE and nothing says why
    const rates = await pool.query("SELECT currency FROM ledger_rates WHERE workspace_id=$1 ORDER BY currency", [workspaceId]);
    expect(rates.rows.map((r) => r.currency)).toEqual(["CAD", "EUR", "GBP", "USD"]);

    const scoped = { "x-workspace-id": workspaceId };
    const opening = await app.inject({
      method: "POST", url: "/api/ledger/opening-balances", cookies: owner, headers: scoped,
      payload: { balances: { CAD: "25000.00", USD: "12000.00" } },
    });
    expect(opening.statusCode).toBe(201);

    const session = await app.inject({ method: "POST", url: "/api/ledger/till-sessions/open", cookies: owner, headers: scoped });
    expect(session.statusCode).toBe(201);

    const customer = await app.inject({
      method: "POST", url: "/api/ledger/customers", cookies: owner, headers: scoped,
      payload: { name: "Walk-in", risk: "normal", idStatus: "verified" },
    });
    expect(customer.statusCode).toBe(201);

    const deal = await app.inject({
      method: "POST", url: "/api/ledger/exchanges", cookies: owner, headers: scoped,
      payload: {
        idempotencyKey: "new-till-first-deal",
        customerId: customer.json().customerId,
        from: "CAD", to: "USD", inputAmount: "1000.00", feeCad: "4.00",
        purpose: "Travel", sourceOfFunds: "Employment income", thirdParty: false,
      },
    });
    expect(deal.statusCode).toBe(201);

    const booked = await pool.query("SELECT till_id FROM ledger_transactions WHERE workspace_id=$1", [workspaceId]);
    expect(booked.rows.map((r) => r.till_id)).toEqual(["till-11"]);
  });

  it("opens a location whose staff can trade there from their first shift", async () => {
    const owner = await login("j.masri");

    const location = await app.inject({
      method: "POST", url: "/api/desk/branches", cookies: owner,
      payload: { name: "Scarborough" },
    });
    expect(location.statusCode).toBe(201);
    const branchId = location.json().branch.id as string;
    const workspaceId = location.json().tills[0].workspaceId as string;

    /* Somebody who works there. The ledger scopes a session to the branch on
       the person's own record, so a location is only staffed once there is
       somebody whose desk it is — which is what this call is for. */
    const hire = await app.inject({
      method: "POST", url: "/api/staff", cookies: owner,
      payload: { staffId: "t.mensah", name: "T. Mensah", role: "supervisor", branchId },
    });
    expect(hire.statusCode).toBe(201);
    const temp = hire.json().signIn.tempPassword as string;
    expect(temp).toBeTruthy();

    const teller = await login("t.mensah", temp);
    const scoped = { "x-workspace-id": workspaceId };

    expect((await app.inject({
      method: "POST", url: "/api/ledger/opening-balances", cookies: teller, headers: scoped,
      payload: { balances: { CAD: "8000.00", USD: "4000.00" } },
    })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/ledger/till-sessions/open", cookies: teller, headers: scoped })).statusCode).toBe(201);

    const customer = await app.inject({
      method: "POST", url: "/api/ledger/customers", cookies: teller, headers: scoped,
      payload: { name: "First customer", risk: "normal", idStatus: "verified" },
    });
    expect(customer.statusCode).toBe(201);

    const deal = await app.inject({
      method: "POST", url: "/api/ledger/exchanges", cookies: teller, headers: scoped,
      payload: {
        idempotencyKey: "scarborough-first-deal",
        customerId: customer.json().customerId,
        from: "CAD", to: "USD", inputAmount: "500.00", feeCad: "3.00",
        purpose: "Travel", sourceOfFunds: "Employment income", thirdParty: false,
      },
    });
    expect(deal.statusCode).toBe(201);

    const booked = await pool.query("SELECT branch_id FROM ledger_transactions WHERE workspace_id=$1", [workspaceId]);
    expect(booked.rows.map((r) => r.branch_id)).toEqual([branchId]);
  });
});
