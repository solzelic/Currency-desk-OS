import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import {
  derivedIdStatus,
  ID_EXPIRED_REASON,
  ID_IDENTIFIED_REASON,
  ID_NEEDED_MESSAGE,
  ID_NO_EXPIRY_REASON,
  ID_NO_ID_REASON,
  ID_NO_NUMBER_REASON,
  ID_STATUS_NOT_CLIENT_MESSAGE,
  ID_TYPE_NOT_STATED_REASON,
} from "../src/ledger/id-on-file.js";
import { fileTypedId } from "./typed-id.js";

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
    "TRUNCATE ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
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
  /* The client file is a different table from the ledger, and reset
     truncates only the ledger. The tenant and the entity have to be
     here on every test: a document filed for a customer is refused
     by the foreign key when they are not, and the tests below must
     not depend on an earlier test having inserted them. */
  await pool.query(
    "INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'York', 'CAD', 'pack-ca-v1', 1)
     ON CONFLICT (id) DO NOTHING`,
    [DEMO.legalEntityId, DEMO.tenantId],
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
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().idStatus).toBe("missing");
    const synced = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: {
        externalRef: "local:jakob-miller",
        name: "Jakob Miller",
        risk: "enhanced",
      },
    });
    expect(synced.json().customerId).toBe(created.json().customerId);
    expect(synced.json()).toMatchObject({
      risk: "enhanced",
      idStatus: "missing",
    });
    const updated = await app.inject({
      method: "PUT",
      url: `/api/ledger/customers/${created.json().customerId}`,
      cookies,
      payload: {
        externalRef: "local:jakob-miller",
        name: "Jakob Miller",
        risk: "normal",
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
    /* The float names the vault. A vault with no opening count is refused,
       so this case states one first. The movement is still the thing under
       test: one key, one credit to the drawer, one debit to the safe. */
    const openedVault = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/opening-position",
      cookies: manager,
      payload: { balances: { CAD: "1000.00" } },
    });
    expect(openedVault.statusCode).toBe(201);
    /* The float is the holder's. A manager may approve, not move cash. */
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "supervisor" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
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
      cookies: teller,
      payload: movePayload,
    });
    expect(moved.statusCode).toBe(201);
    expect(moved.json().balances.CAD).toBe("25100.00");
    expect(moved.json().vaultBalances.CAD).toBe("900.00");
    const replayedMove = await app.inject({
      method: "POST",
      url: "/api/ledger/till-movements",
      cookies: teller,
      payload: movePayload,
    });
    expect(replayedMove.json().balances.CAD).toBe("25100.00");
    expect(replayedMove.json().vaultBalances.CAD).toBe("900.00");

    const countedAgainst = await app.inject({
      method: "GET",
      url: "/api/ledger/till-balances",
      cookies: manager,
    });
    expect(countedAgainst.statusCode).toBe(200);
    const balanceGeneration = countedAgainst.json().balanceGeneration;

    const incomplete = await app.inject({
      method: "POST",
      url: "/api/ledger/till-sessions/session-1/close",
      cookies: manager,
      payload: {
        idempotencyKey: "close-incomplete",
        counts: { CAD: "25100.00" },
        note: "Incomplete",
        balanceGeneration,
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
        balanceGeneration,
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

  it("rounds a legacy direct post to whole yen", async () => {
    const scope = [
      DEMO.tenantId,
      DEMO.legalEntityId,
      DEMO.branchId,
      DEMO.workspaceId,
      "till-01",
    ];
    await pool.query(
      "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'JPY',110.456)",
      scope.slice(0, 4),
    );
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,'JPY',200000)",
      scope,
    );
    /* 100 CAD at 110.456 is 11045.60. Whole yen, half up, is 11046.
       Two stored places keep that as 11046.00. Two-place rounding
       of the product is 11045.60. */
    const posted = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies: await cookie(),
      payload: {
        idempotencyKey: "legacy-jpy",
        customerId: "customer-demo",
        from: "CAD",
        to: "JPY",
        inputAmount: "100.00",
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Cash",
      },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    expect(posted.json().outputAmount).toBe("11046.00");
    expect(posted.json().receipt.lines).toContain("Received: 11046 JPY");
    const row = await pool.query(
      "SELECT output_amount FROM ledger_transactions WHERE transaction_id=$1",
      [posted.json().transactionId],
    );
    expect(row.rows[0].output_amount).toBe("11046.00");
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

  it("lists the tills this session's branch has, without being told which one", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/ledger/workspaces",
      cookies: await cookie(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      workspaces: [
        {
          workspaceId: DEMO.workspaceId,
          tillId: "till-01",
          branchId: DEMO.branchId,
          branchName: "Yorkville Desk",
        },
      ],
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/ledger/workspaces" }))
        .statusCode,
    ).toBe(401);
  });

  /* A second till used to deny every caller that omitted x-workspace-id.
     The session now carries the drawer this login is sitting at, so an
     unscoped call keeps answering for that till; a named header still
     selects the other one. Both can post. */
  it("answers for the session workspace once a branch has a second till, and for each named till", async () => {
    const secondWorkspaceId = "ws-yorkville-till-02";
    await handle.db.insert(schema.workspaces).values({
      id: secondWorkspaceId,
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      tillId: "till-02",
    });
    try {
      const cookies = await cookie();
      const listed = await app.inject({
        method: "GET",
        url: "/api/ledger/workspaces",
        cookies,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().workspaces.map((w: { tillId: string }) => w.tillId)).toEqual([
        "till-01",
        "till-02",
      ]);

      const unscoped = await app.inject({
        method: "GET",
        url: "/api/ledger/till-balances",
        cookies,
      });
      expect(unscoped.statusCode).toBe(200);
      expect(unscoped.json()).toMatchObject({
        tillId: "till-01",
        balances: { CAD: "25000.00" },
      });

      const first = await app.inject({
        method: "GET",
        url: "/api/ledger/till-balances",
        cookies,
        headers: { "x-workspace-id": DEMO.workspaceId },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        tillId: "till-01",
        balances: { CAD: "25000.00" },
      });

      const second = await app.inject({
        method: "GET",
        url: "/api/ledger/till-balances",
        cookies,
        headers: { "x-workspace-id": secondWorkspaceId },
      });
      expect(second.statusCode).toBe(200);
      // a drawer of its own: same branch, its own till, none of till-01's money
      expect(second.json()).toEqual({
        tillId: "till-02",
        balances: {},
        balanceGeneration: "0",
      });

      const quoteBody = {
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "100.00",
        feeCad: "0.00",
        direction: "customer_buy_foreign",
      };
      const quotedHome = await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies,
        payload: quoteBody,
      });
      expect(quotedHome.statusCode).not.toBe(403);

      const quoted = await app.inject({
        method: "POST",
        url: "/api/quotes",
        cookies,
        headers: { "x-workspace-id": secondWorkspaceId },
        payload: quoteBody,
      });
      // the second drawer is empty of rates/customers; the assertion is that
      // naming it is not SCOPE_DENIED now that the branch has two tills
      expect(quoted.statusCode).not.toBe(403);
    } finally {
      await pool.query("DELETE FROM ledger_principals WHERE workspace_id=$1", [
        secondWorkspaceId,
      ]);
      await handle.db
        .delete(schema.workspaces)
        .where(eq(schema.workspaces.id, secondWorkspaceId));
    }
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

  /* ID standing is the server's. A teller and an owner are the same
     caller here: neither may name it, in any spelling. */
  const idStatusVariants = [
    { label: "camelCase idStatus", body: { idStatus: "verified" } },
    { label: "camelCase kycStatus", body: { kycStatus: "verified" } },
    { label: "snake_case id_status", body: { id_status: "verified" } },
    { label: "snake_case kyc_status", body: { kyc_status: "verified" } },
    { label: "nested identity status", body: { identity: { status: "verified" } } },
    { label: "nested kyc id_status", body: { kyc: { id_status: "verified" } } },
    { label: "verified flag", body: { verified: true } },
    { label: "idVerified flag", body: { idVerified: true } },
  ];

  for (const role of [
    { staffId: "a.singh", name: "teller" },
    { staffId: "j.masri", name: "owner" },
  ]) {
    for (const method of ["POST", "PUT"] as const) {
      for (const variant of idStatusVariants) {
        it(`rejects ${variant.label} on ${method} for a ${role.name}`, async () => {
          const cookies = await cookie(role.staffId);
          const response = await app.inject({
            method,
            url: method === "POST" ? "/api/ledger/customers" : "/api/ledger/customers/customer-demo",
            cookies,
            payload: {
              name: "Demo Customer",
              risk: "normal",
              ...variant.body,
            },
          });
          expect(response.statusCode, response.body).toBe(422);
          expect(response.json()).toMatchObject({
            code: "ID_STATUS_NOT_CLIENT_SET",
            message: ID_STATUS_NOT_CLIENT_MESSAGE,
          });
          const stored = await pool.query(
            "SELECT id_status FROM ledger_customers WHERE customer_id='customer-demo'",
          );
          expect(stored.rows[0].id_status).toBe("verified");
        });
      }
    }
  }

  it("treats a typed identity document as ID on file for a large deal", async () => {
    const cookies = await cookie();
    const created = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: { name: "Ada Conductor", risk: "normal" },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().idStatus).toBe("missing");
    const customerId = created.json().customerId as string;
    await pool.query(
      "INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT DO NOTHING",
      [DEMO.tenantId],
    );
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, name, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
       VALUES ($1, $2, 'York', 'CAD', 'pack-ca-v1', 1)
       ON CONFLICT (id) DO NOTHING`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    await fileTypedId(pool, customerId);
    const listed = await app.inject({
      method: "GET",
      url: "/api/ledger/customers",
      cookies,
    });
    const row = listed.json().customers.find(
      (customer: { customerId: string }) => customer.customerId === customerId,
    );
    expect(row.idStatus).toBe("verified");
    expect(row.idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });

    const posted = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: {
        idempotencyKey: "typed-id-large",
        customerId,
        from: "CAD",
        to: "USD",
        inputAmount: "3000.00",
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Salary",
        thirdParty: false,
      },
    });
    expect(posted.statusCode, posted.body).toBe(201);
  });

  it("refuses a large deal with no document even when the client sent idStatus verified", async () => {
    const cookies = await cookie();
    const poisoned = await app.inject({
      method: "PUT",
      url: "/api/ledger/customers/customer-demo",
      cookies,
      payload: { name: "Demo Customer", risk: "normal", idStatus: "verified" },
    });
    expect(poisoned.statusCode, poisoned.body).toBe(422);
    expect(poisoned.json().code).toBe("ID_STATUS_NOT_CLIENT_SET");
    /* The seeded row already says verified and has no document. That is
       an existing customer, and the gate must not honour the column. */
    const posted = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: {
        idempotencyKey: "no-document-large",
        customerId: "customer-demo",
        from: "CAD",
        to: "USD",
        inputAmount: "3000.00",
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Salary",
        thirdParty: false,
      },
    });
    expect(posted.statusCode, posted.body).toBe(422);
    expect(posted.json()).toMatchObject({
      code: "COMPLIANCE_BLOCKED",
      message: ID_NEEDED_MESSAGE,
    });
    const booked = await pool.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE customer_id='customer-demo'",
    );
    expect(booked.rows[0].n).toBe(0);
  });

  async function exchange(
    cookies: { cdos_session: string },
    customerId: string,
    amount: string,
    key: string,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: {
        idempotencyKey: key,
        customerId,
        from: "CAD",
        to: "USD",
        inputAmount: amount,
        feeCad: "0.00",
        purpose: "Travel",
        sourceOfFunds: "Salary",
        thirdParty: false,
      },
    });
  }

  async function openClient(cookies: { cdos_session: string }, name: string) {
    const created = await app.inject({
      method: "POST",
      url: "/api/clients",
      cookies,
      payload: { legalName: name, kind: "individual" },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { clientId: string; idStanding: { label: string; reason: string } };
  }

  async function fileDocument(
    cookies: { cdos_session: string },
    clientId: string,
    document: Record<string, unknown>,
  ) {
    const filed = await app.inject({
      method: "POST",
      url: `/api/clients/${clientId}/documents`,
      cookies,
      payload: document,
    });
    expect(filed.statusCode, filed.body).toBe(201);
    return filed.json() as {
      clientId: string;
      idStanding: { label: string; reason: string; tone: string };
      displayedDocument: { docType: string; docNumber: string | null; isPrimary: boolean } | null;
    };
  }

  async function counterId(clientId: string) {
    const found = await pool.query(
      "SELECT customer_id FROM ledger_customers WHERE client_id=$1",
      [clientId],
    );
    expect(found.rowCount).toBe(1);
    return found.rows[0]!.customer_id as string;
  }

  /* Each of these is the test that goes red when that one check is
     taken out of the standing expression. A document that fails the
     check must not post at the identification line or above the
     large-cash line. */
  for (const amount of ["3000.00", "10500.00"]) {
    it(`refuses ${amount} when the only document is an expired non-primary passport`, async () => {
      const cookies = await cookie();
      const client = await openClient(cookies, `Expired secondary ${amount}`);
      const filed = await fileDocument(cookies, client.clientId, {
        docType: "Passport",
        docNumber: `EXP-${amount}`,
        expiresOn: "2001-01-01",
        isPrimary: false,
      });
      expect(filed.idStanding).toEqual({ label: "Expired", reason: ID_EXPIRED_REASON, tone: "warning" });
      const posted = await exchange(cookies, await counterId(client.clientId), amount, `exp-${amount}`);
      expect(posted.statusCode, posted.body).toBe(422);
      expect(posted.json().message).toBe(ID_NEEDED_MESSAGE);
    });

    it(`refuses ${amount} when the only document type is Not stated`, async () => {
      const cookies = await cookie();
      const client = await openClient(cookies, `Not stated ${amount}`);
      const filed = await fileDocument(cookies, client.clientId, {
        docType: "Not stated",
        docNumber: `NS-${amount}`,
        expiresOn: "2031-05-01",
      });
      expect(filed.idStanding).toEqual({ label: "Missing ID", reason: ID_TYPE_NOT_STATED_REASON, tone: "warning" });
      const posted = await exchange(cookies, await counterId(client.clientId), amount, `ns-${amount}`);
      expect(posted.statusCode, posted.body).toBe(422);
      expect(posted.json().message).toBe(ID_NEEDED_MESSAGE);
    });

    it(`refuses ${amount} when the number is only a zero-width space`, async () => {
      const cookies = await cookie();
      const client = await openClient(cookies, `Zero width ${amount}`);
      const filed = await fileDocument(cookies, client.clientId, {
        docType: "Passport",
        docNumber: "\u200B\u200B",
        expiresOn: "2031-05-01",
      });
      expect(filed.idStanding).toEqual({ label: "Missing ID", reason: ID_NO_NUMBER_REASON, tone: "warning" });
      const posted = await exchange(cookies, await counterId(client.clientId), amount, `zw-${amount}`);
      expect(posted.statusCode, posted.body).toBe(422);
      expect(posted.json().message).toBe(ID_NEEDED_MESSAGE);
    });
  }

  it("refuses a large deal when the number is only non-breaking spaces", async () => {
    const cookies = await cookie();
    const created = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: { name: "NBSP number", risk: "normal" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const customerId = created.json().customerId as string;
    /* The client route's trim already drops NBSP, so this row is
       written the way a migration can write it: the characters are
       in the table. btrim does not remove them. The strip has to. */
    await fileTypedId(pool, customerId, { number: "\u00A0\u00A0", expiresOn: "2031-05-01" });
    const listed = await app.inject({ method: "GET", url: "/api/ledger/customers", cookies });
    const row = listed.json().customers.find(
      (customer: { customerId: string }) => customer.customerId === customerId,
    );
    expect(row.idStanding).toEqual({ label: "Missing ID", reason: ID_NO_NUMBER_REASON, tone: "warning" });
    for (const amount of ["3000.00", "10500.00"]) {
      const posted = await exchange(cookies, customerId, amount, `nbsp-${amount}`);
      expect(posted.statusCode, posted.body).toBe(422);
      expect(posted.json().message).toBe(ID_NEEDED_MESSAGE);
    }
  });

  it("treats a current secondary document as ID on file, and a blank number as not", async () => {
    const cookies = await cookie();
    const current = await openClient(cookies, "Secondary current");
    const filed = await fileDocument(cookies, current.clientId, {
      docType: "Passport",
      docNumber: "SEC-1",
      expiresOn: "2031-05-01",
      isPrimary: false,
    });
    expect(filed.idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });
    expect(filed).toMatchObject({
      displayedDocument: { docType: "Passport", docNumber: "SEC-1", isPrimary: false },
    });
    const posted = await exchange(cookies, await counterId(current.clientId), "3000.00", "secondary-current");
    expect(posted.statusCode, posted.body).toBe(201);

    const blank = await openClient(cookies, "Blank number");
    const empty = await fileDocument(cookies, blank.clientId, {
      docType: "Passport",
      docNumber: "   ",
      expiresOn: "2031-05-01",
    });
    expect(empty.idStanding).toEqual({ label: "Missing ID", reason: ID_NO_NUMBER_REASON, tone: "warning" });
    const refused = await exchange(cookies, await counterId(blank.clientId), "3000.00", "blank-number");
    expect(refused.statusCode, refused.body).toBe(422);
  });

  it("keeps ID on file when the primary is expired and a secondary document is current", async () => {
    const cookies = await cookie();
    const client = await openClient(cookies, "Primary expired");
    await fileDocument(cookies, client.clientId, {
      docType: "Passport",
      docNumber: "PRI-OLD",
      expiresOn: "2001-01-01",
      isPrimary: true,
    });
    const filed = await fileDocument(cookies, client.clientId, {
      docType: "Driver licence",
      docNumber: "SEC-NEW",
      expiresOn: "2031-05-01",
      isPrimary: false,
    });
    expect(filed.idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });
    expect(filed.displayedDocument).toMatchObject({ docType: "Passport", isPrimary: true });
    const posted = await exchange(cookies, await counterId(client.clientId), "3000.00", "primary-expired-secondary-current");
    expect(posted.statusCode, posted.body).toBe(201);
  });

  it("counts a blank or missing expiry as missing ID", async () => {
    const cookies = await cookie();
    /* Null and a cleared field are the same stored date. Neither is
       on file. A deal at the identification line is refused. */
    const missing = await openClient(cookies, "No expiry");
    const filed = await fileDocument(cookies, missing.clientId, {
      docType: "Passport",
      docNumber: "NO-EXP",
      expiresOn: null,
    });
    expect(filed.idStanding).toEqual({ label: "Missing ID", reason: ID_NO_EXPIRY_REASON, tone: "warning" });
    const posted = await exchange(cookies, await counterId(missing.clientId), "3000.00", "no-expiry");
    expect(posted.statusCode, posted.body).toBe(422);
    expect(posted.json().message).toBe(ID_NEEDED_MESSAGE);

    const blank = await openClient(cookies, "Blank expiry");
    const cleared = await fileDocument(cookies, blank.clientId, {
      docType: "Passport",
      docNumber: "BLANK-EXP",
      expiresOn: "",
    });
    expect(cleared.idStanding).toEqual({ label: "Missing ID", reason: ID_NO_EXPIRY_REASON, tone: "warning" });
    const refused = await exchange(cookies, await counterId(blank.clientId), "3000.00", "blank-expiry");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toBe(ID_NEEDED_MESSAGE);
  });

  it("still reads every document when one expiry is blank", async () => {
    const cookies = await cookie();
    /* The blank paper is the one the desk shows. The secondary
       document is what the standing is judged on. */
    const current = await openClient(cookies, "Blank beside current");
    await fileDocument(cookies, current.clientId, {
      docType: "Passport",
      docNumber: "BLANK-PRI",
      expiresOn: "",
      isPrimary: true,
    });
    const filed = await fileDocument(cookies, current.clientId, {
      docType: "Driver licence",
      docNumber: "CUR-SEC",
      expiresOn: "2031-05-01",
      isPrimary: false,
    });
    expect(filed.idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });
    expect(filed.displayedDocument).toMatchObject({ docType: "Passport", isPrimary: true });
    const posted = await exchange(cookies, await counterId(current.clientId), "3000.00", "blank-beside-current");
    expect(posted.statusCode, posted.body).toBe(201);

    const old = await openClient(cookies, "Blank beside expired");
    await fileDocument(cookies, old.clientId, {
      docType: "Passport",
      docNumber: "BLANK-OLD",
      expiresOn: null,
      isPrimary: true,
    });
    const expired = await fileDocument(cookies, old.clientId, {
      docType: "Driver licence",
      docNumber: "OLD-SEC",
      expiresOn: "2001-01-01",
      isPrimary: false,
    });
    expect(expired.idStanding).toEqual({ label: "Expired", reason: ID_EXPIRED_REASON, tone: "warning" });
    const refused = await exchange(cookies, await counterId(old.clientId), "3000.00", "blank-beside-expired");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toBe(ID_NEEDED_MESSAGE);
  });

  it("uses the branch's business date, not UTC, across midnight", async () => {
    const cookies = await cookie();
    await pool.query(
      `INSERT INTO branches (id, tenant_id, legal_entity_id, name, timezone)
       VALUES ($1, $2, $3, 'Yorkville', 'America/Toronto')
       ON CONFLICT (id) DO UPDATE SET timezone = 'America/Toronto'`,
      [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: { name: "Midnight expiry", risk: "normal" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const customerId = created.json().customerId as string;
    /* Expires on the Toronto date of the earlier instant. That instant
       is still 11 October in Toronto and already 12 October in UTC.
       The later instant is 12 October in both. current_date cannot
       satisfy both expectations. */
    await fileTypedId(pool, customerId, { expiresOn: "2026-10-11" });
    const db = await pool.connect();
    try {
      const stillThatDay = await derivedIdStatus(
        db,
        customerId,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        new Date("2026-10-12T03:30:00Z"),
      );
      const nextDay = await derivedIdStatus(
        db,
        customerId,
        DEMO.tenantId,
        DEMO.legalEntityId,
        DEMO.branchId,
        new Date("2026-10-12T04:30:00Z"),
      );
      expect(stillThatDay).toBe("verified");
      expect(nextDay).toBe("expired");
    } finally {
      db.release();
    }
  });

  it("posts a large deal for an identified client when the till sync carries the client id", async () => {
    const cookies = await cookie();
    const client = await openClient(cookies, "Nadia Passport");
    const filed = await fileDocument(cookies, client.clientId, {
      docType: "Passport",
      docNumber: "P7712345",
      expiresOn: "2031-05-01",
    });
    expect(filed.idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });
    const unlinked = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: { externalRef: "os:nadia-passport", name: "Nadia Passport", risk: "normal" },
    });
    expect(unlinked.statusCode, unlinked.body).toBe(201);
    expect(unlinked.json().idStanding).toEqual({ label: "Missing ID", reason: ID_NO_ID_REASON, tone: "warning" });
    const refused = await exchange(cookies, unlinked.json().customerId, "3000.00", "nadia-unlinked");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().message).toBe(ID_NEEDED_MESSAGE);

    const linked = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: {
        externalRef: "os:nadia-passport",
        name: "Nadia Passport",
        risk: "normal",
        clientId: client.clientId,
      },
    });
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json().idStanding).toEqual({ label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" });
    expect(linked.json().clientId).toBe(client.clientId);
    const posted = await exchange(cookies, linked.json().customerId, "3000.00", "nadia-linked");
    expect(posted.statusCode, posted.body).toBe(201);
  });
});
