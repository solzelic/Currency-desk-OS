import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

const post = {
  idempotencyKey: "route-post",
  customerId: "customer-demo",
  from: "CAD",
  to: "USD",
  inputAmount: "1000.00",
  feeCad: "4.00",
  purpose: "Travel",
  sourceOfFunds: "Cash",
  thirdParty: true,
  thirdPartyName: "Family Member",
};

async function cookie(staffId = "a.singh") {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password },
  });
  return {
    cdos_session: login.cookies.find(
      (item) => item.name === "cdos_session",
    )!.value,
  };
}

async function resetLedger() {
  await pool.query(
    "TRUNCATE quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  const scope = [
    DEMO.tenantId,
    DEMO.legalEntityId,
    DEMO.branchId,
    DEMO.workspaceId,
    "till-01",
  ];
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
  ]) {
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

postgres("ledger HTTP routes against real PostgreSQL", () => {
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
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "teller" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
    await resetLedger();
  });

  it("refreshes the ledger principal from authenticated staff", async () => {
    await pool.query("DELETE FROM ledger_principals");
    const response = await app.inject({
      method: "GET",
      url: "/api/ledger/readiness",
      cookies: await cookie(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ principal: true });
    const principal = await pool.query(
      "SELECT role,authorized_branch_ids FROM ledger_principals WHERE user_id=$1",
      [`${DEMO.tenantId}:a.singh`],
    );
    expect(principal.rows[0]).toMatchObject({
      role: "teller",
      authorized_branch_ids: [DEMO.branchId],
    });
  });

  it("creates, idempotently syncs, lists, and updates scoped customers", async () => {
    const cookies = await cookie();
    const created = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: {
        externalRef: "local:jakob-miller",
        name: "Jakob Miller",
        risk: "normal",
        idStatus: "verified",
      },
    });
    expect(created.statusCode).toBe(201);
    const synced = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: {
        externalRef: "local:jakob-miller",
        name: "Jakob Miller",
        risk: "enhanced",
        idStatus: "pending",
      },
    });
    expect(synced.json().customerId).toBe(created.json().customerId);
    expect(synced.json()).toMatchObject({
      risk: "enhanced",
      idStatus: "pending",
    });
    const updated = await app.inject({
      method: "PUT",
      url: `/api/ledger/customers/${created.json().customerId}`,
      cookies,
      payload: {
        externalRef: "local:jakob-miller",
        name: "Jakob Miller",
        risk: "normal",
        idStatus: "verified",
      },
    });
    expect(updated.statusCode).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/customers",
      cookies,
    });
    expect(
      listed
        .json()
        .customers.filter(
          (customer: { externalRef: string | null }) =>
            customer.externalRef === "local:jakob-miller",
        ),
    ).toHaveLength(1);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM ledger_audit_events WHERE target_id=$1",
          [created.json().customerId],
        )
      ).rows[0].count,
    ).toBe("3");

    const second = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: {
        externalRef: "local:second",
        name: "Second Customer",
        risk: "normal",
        idStatus: "missing",
      },
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/ledger/customers/${second.json().customerId}`,
          cookies,
          payload: {
            externalRef: "local:jakob-miller",
            name: "Second Customer",
            risk: "normal",
            idStatus: "missing",
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("does not expose or update a customer outside the active workspace", async () => {
    await pool.query(
      `INSERT INTO ledger_customers
        (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status)
       VALUES ('other-customer',$1,$2,$3,'other-workspace','Other','normal','verified')`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
    );
    const cookies = await cookie();
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/customers",
      cookies,
    });
    expect(
      listed
        .json()
        .customers.some(
          (customer: { customerId: string }) =>
            customer.customerId === "other-customer",
        ),
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/ledger/customers/other-customer",
          cookies,
          payload: {
            name: "Changed",
            risk: "normal",
            idStatus: "verified",
          },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("initializes till balances once with manager authority", async () => {
    await pool.query("DELETE FROM ledger_till_balances");
    const teller = await cookie();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ledger/opening-balances",
          cookies: teller,
          payload: { balances: { CAD: "1000.00", USD: "500.00" } },
        })
      ).statusCode,
    ).toBe(403);
    const manager = await cookie("r.haddad");
    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/opening-balances",
      cookies: manager,
      payload: { balances: { CAD: "1000.00", USD: "500.00" } },
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().balances).toEqual({
      CAD: "1000.00",
      USD: "500.00",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ledger/opening-balances",
          cookies: manager,
          payload: { balances: { CAD: "2000.00" } },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("records idempotent counts, moves cash, closes the till, and blocks posting", async () => {
    const teller = await cookie();
    const manager = await cookie("r.haddad");
    const current = await app.inject({
      method: "GET",
      url: "/api/ledger/till-session",
      cookies: teller,
    });
    expect(current.statusCode).toBe(200);
    expect(current.json().session).toMatchObject({
      sessionId: "session-1",
      status: "open",
    });

    const countPayload = {
      idempotencyKey: "count-1",
      counts: { CAD: "25000.00" },
    };
    const counted = await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: countPayload,
    });
    expect(counted.statusCode).toBe(201);
    expect(counted.json().latestCounts.CAD).toMatchObject({
      expected: "25000.00",
      counted: "25000.00",
      variance: "0.00",
    });
    await app.inject({
      method: "POST",
      url: "/api/ledger/till-counts",
      cookies: teller,
      payload: countPayload,
    });
    expect(
      (await pool.query("SELECT count(*) FROM ledger_till_count_batches")).rows[0]
        .count,
    ).toBe("1");

    const deniedMove = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: teller,
      payload: {
        idempotencyKey: "move-denied",
        direction: "in",
        currency: "CAD",
        amount: "100.00",
        counterpartyType: "vault",
        counterpartyRef: "vault-1",
        reason: "Issue float",
      },
    });
    expect(deniedMove.statusCode).toBe(403);
    const movePayload = {
      idempotencyKey: "move-1",
      direction: "in",
      currency: "CAD",
      amount: "100.00",
      counterpartyType: "vault",
      counterpartyRef: "vault-1",
      reason: "Issue float",
    };
    const moved = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: manager,
      payload: movePayload,
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().balances.CAD).toBe("25100.00");
    const replayedMove = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: manager,
      payload: movePayload,
    });
    expect(replayedMove.json().balances.CAD).toBe("25100.00");

    const incomplete = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/session-1/close",
      cookies: manager,
      payload: {
        idempotencyKey: "close-incomplete",
        counts: { CAD: "25100.00" },
        note: "Incomplete",
      },
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().code).toBe("INCOMPLETE_TILL_COUNT");

    const closed = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/session-1/close",
      cookies: manager,
      payload: {
        idempotencyKey: "close-1",
        counts: {
          CAD: "25090.00",
          USD: "12000.00",
          EUR: "7000.00",
          GBP: "3500.00",
        },
        note: "Variance close",
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().session).toMatchObject({
      sessionId: "session-1",
      status: "closed",
      closeNote: "Variance close",
    });
    expect(closed.json().latestCounts.CAD).toMatchObject({
      expected: "25100.00",
      counted: "25090.00",
      variance: "-10.00",
    });
    expect(
      (
        await pool.query(
          "SELECT available_amount FROM ledger_till_balances WHERE currency='CAD'",
        )
      ).rows[0].available_amount,
    ).toBe("25090.00");
    expect(
      (await pool.query("SELECT count(*) FROM ledger_till_counts")).rows[0].count,
    ).toBe("5");
    await expect(
      pool.query("UPDATE ledger_till_counts SET counted_amount=0"),
    ).rejects.toThrow(/append-only ledger record/);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: teller,
      payload: post,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("TILL_NOT_OPEN");

    const opened = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/open",
      cookies: teller,
      payload: {},
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json().session).toMatchObject({
      sessionNumber: 2,
      status: "open",
    });
  });

  it("posts, reads, and returns reversal state through HTTP", async () => {
    const teller = await cookie();
    const posted = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: teller,
      payload: post,
    });
    expect(posted.statusCode).toBe(201);
    const manager = await cookie("r.haddad");
    const reversed = await app.inject({
      method: "POST",
      url: `/api/ledger/transactions/${posted.json().transactionId}/reversal`,
      cookies: manager,
      payload: { idempotencyKey: "reverse", reason: "Correction" },
    });
    expect(reversed.statusCode).toBe(201);
    const ledger = await app.inject({
      method: "GET",
      url: "/api/ledger/transactions?limit=10",
      cookies: teller,
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().transactions).toHaveLength(1);
    expect(ledger.json().transactions[0]).toMatchObject({
      transactionId: posted.json().transactionId,
      thirdParty: true,
      thirdPartyName: "Family Member",
      reversal: {
        reversalId: reversed.json().reversalId,
        reason: "Correction",
      },
    });
    const receipt = await app.inject({
      method: "GET",
      url: `/api/ledger/transactions/${posted.json().transactionId}/receipt`,
      cookies: teller,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      transactionId: posted.json().transactionId,
      transactionRef: posted.json().transactionRef,
    });
    expect(receipt.json().lines.join(" ")).toContain("Demo Customer");
  });

  it("deduplicates posting and derives authorization from the staff record", async () => {
    const cookies = await cookie();
    const first = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: post,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: post,
    });
    expect(replay.json().transactionId).toBe(first.json().transactionId);
    expect(
      (await pool.query("SELECT count(*) FROM ledger_transactions")).rows[0]
        .count,
    ).toBe("1");

    await handle.db
      .update(schema.staffUsers)
      .set({ role: "auditor" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
    const denied = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: { ...post, idempotencyKey: "role-denied" },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      (
        await pool.query(
          "SELECT role FROM ledger_principals WHERE user_id=$1",
          [`${DEMO.tenantId}:a.singh`],
        )
      ).rows[0].role,
    ).toBe("auditor");
  });

  it("returns 401 for no session and 403 for invalid workspace", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/ledger/readiness",
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/ledger/readiness",
          cookies: await cookie(),
          headers: { "x-workspace-id": "missing" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("rejects malformed provisioning inputs", async () => {
    const cookies = await cookie();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ledger/customers",
          cookies,
          payload: {
            name: "",
            risk: "made-up",
            idStatus: "verified",
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ledger/opening-balances",
          cookies,
          payload: { balances: {} },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/ledger/transactions?limit=1000",
          cookies,
        })
      ).statusCode,
    ).toBe(400);
  });
});
