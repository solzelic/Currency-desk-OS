/* ============================================================
   The vault, against real PostgreSQL.

   The rule these tests exist to hold: a float is one movement of money
   with two ends. Before the vault was on the ledger, a drawer could be
   floated from a strong room the server had no balance for, and the only
   record of the vault side lived in one browser. Every case below is a
   way that could go wrong — the vault overdrawn, one leg landing without
   the other, a retry moving the money twice, a run reaching a branch the
   operator may not touch.
   ============================================================ */
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
const OTHER_BRANCH = "br-vault-second";
let pool: pg.Pool;
let app: FastifyInstance;
let handle: DbHandle;

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

const scope = [
  DEMO.tenantId,
  DEMO.legalEntityId,
  DEMO.branchId,
  DEMO.workspaceId,
  "till-01",
];

async function reset(authorized: string[] = [DEMO.branchId]) {
  await pool.query(
    "TRUNCATE ledger_cost_events,ledger_vault_movements,ledger_vault_balances,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_till_balances,ledger_principals CASCADE",
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1||':a.singh',$1,$2,$3,$4,$5,'branch_manager',$6)`,
    [...scope, JSON.stringify(authorized)],
  );
  await handle.db
    .update(schema.staffUsers)
    .set({ role: "branch_manager", authorizedBranchIds: authorized })
    .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
  for (const [currency, value] of [["CAD", 25000], ["USD", 12000]] as const) {
    await pool.query(
      "INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [...scope, currency, value],
    );
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('vault-session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())`,
    scope,
  );
}

const openVault = async (
  balances: Record<string, string>,
  cookies: Record<string, string>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/vault/opening-position",
    payload: { balances },
    cookies,
  });

const float = async (
  cookies: Record<string, string>,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/till-movements",
    payload: {
      counterpartyType: "vault",
      counterpartyRef: `${DEMO.branchId}:vault`,
      reason: "float",
      ...body,
    },
    cookies,
  });

const vaultOf = async (cookies: Record<string, string>) =>
  (await app.inject({ method: "GET", url: "/api/ledger/vault", cookies })).json();

postgres("vault control against real PostgreSQL", () => {
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

  it("reports an unstated vault as untracked and leaves floats unbalanced", async () => {
    const cookies = await cookie();
    expect((await vaultOf(cookies)).tracked).toBe(false);

    /* A desk that has never said what is in its safe is not balanced
       against zero — that would be inventing a figure for their cash. The
       float still works and says plainly that the vault side is untracked. */
    const response = await float(cookies, {
      idempotencyKey: "pre-vault",
      direction: "in",
      currency: "CAD",
      amount: "100.00",
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().vaultTracked).toBe(false);
    expect(response.json().balances.CAD).toBe("25100.00");
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_vault_movements"))
        .rows[0].n,
    ).toBe(0);
  });

  it("states an opening position exactly once", async () => {
    const cookies = await cookie();
    const first = await openVault({ CAD: "50000.00", USD: "20000.00" }, cookies);
    expect(first.statusCode).toBe(201);
    expect(first.json().tracked).toBe(true);
    expect(first.json().balances).toEqual({ CAD: "50000.00", USD: "20000.00" });

    const again = await openVault({ CAD: "1.00" }, cookies);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("VAULT_ALREADY_INITIALIZED");
    expect((await vaultOf(cookies)).balances.CAD).toBe("50000.00");
  });

  it("moves both boxes when a drawer is floated, and neither when it cannot", async () => {
    const cookies = await cookie();
    await openVault({ CAD: "50000.00", USD: "20000.00" }, cookies);

    const issued = await float(cookies, {
      idempotencyKey: "issue-1",
      direction: "in",
      currency: "CAD",
      amount: "5000.00",
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().balances.CAD).toBe("30000.00");      // the drawer
    expect(issued.json().vaultBalances.CAD).toBe("45000.00"); // the strong room

    const returned = await float(cookies, {
      idempotencyKey: "return-1",
      direction: "out",
      currency: "CAD",
      amount: "1200.00",
    });
    expect(returned.json().balances.CAD).toBe("28800.00");
    expect(returned.json().vaultBalances.CAD).toBe("46200.00");

    /* the vault holds 20,000 USD; asking for more must leave BOTH sides
       exactly as they were, not just refuse the vault half */
    const tooMuch = await float(cookies, {
      idempotencyKey: "issue-overdraw",
      direction: "in",
      currency: "USD",
      amount: "20000.01",
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().code).toBe("INSUFFICIENT_VAULT_LIQUIDITY");
    const after = await vaultOf(cookies);
    expect(after.balances.USD).toBe("20000.00");
    expect(
      (
        await pool.query(
          "SELECT available_amount FROM ledger_till_balances WHERE currency='USD'",
        )
      ).rows[0].available_amount,
    ).toBe("12000.00");
  });

  it("links each vault leg to the till movement it balances", async () => {
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);
    const issued = await float(cookies, {
      idempotencyKey: "issue-linked",
      direction: "in",
      currency: "CAD",
      amount: "900.00",
      reason: "morning float",
    });
    const leg = (
      await pool.query(
        "SELECT * FROM ledger_vault_movements WHERE counterparty_type='till'",
      )
    ).rows[0];
    expect(leg.direction).toBe("out");
    expect(leg.related_movement_id).toBe(issued.json().movement.movementId);
    expect(leg.counterparty_ref).toBe("till-01");
    expect(leg.reason).toBe("morning float");
  });

  it("does not move the money twice when a float is retried", async () => {
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);
    const body = {
      idempotencyKey: "issue-retry",
      direction: "in",
      currency: "CAD",
      amount: "2500.00",
    };
    const first = await float(cookies, body);
    const second = await float(cookies, body);
    expect(first.json().vaultBalances.CAD).toBe("47500.00");
    expect(second.json().vaultBalances.CAD).toBe("47500.00");
    expect(second.json().movement.movementId).toBe(first.json().movement.movementId);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM ledger_vault_movements"))
        .rows[0].n,
    ).toBe(1);
  });

  it("records a supplier delivery and a bank deposit", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies);
    const delivery = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/receipts",
      payload: {
        idempotencyKey: "wholesale-1",
        direction: "in",
        currency: "USD",
        amount: "15000.00",
        counterpartyType: "supplier",
        counterpartyRef: "Continental FX",
        reason: "weekly USD order",
      },
      cookies,
    });
    expect(delivery.statusCode).toBe(201);
    expect(delivery.json().balances.USD).toBe("35000.00");
    expect(delivery.json().movement.relatedMovementId).toBeNull();

    const deposit = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/receipts",
      payload: {
        idempotencyKey: "deposit-1",
        direction: "out",
        currency: "USD",
        amount: "30000.00",
        counterpartyType: "bank",
        counterpartyRef: "RBC 0142",
        reason: "surplus banked",
      },
      cookies,
    });
    expect(deposit.json().balances.USD).toBe("5000.00");
  });

  it("runs cash between two vaults as one movement with two legs", async () => {
    await reset([DEMO.branchId, OTHER_BRANCH]);
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);
    await pool.query(
      "INSERT INTO ledger_vault_balances VALUES ($1,$2,$3,'CAD',1000)",
      [DEMO.tenantId, DEMO.legalEntityId, OTHER_BRANCH],
    );

    const run = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-1",
        toBranchId: OTHER_BRANCH,
        currency: "CAD",
        amount: "7500.00",
        reason: "armoured run",
      },
      cookies,
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().branches[DEMO.branchId].CAD).toBe("42500.00");
    expect(run.json().branches[OTHER_BRANCH].CAD).toBe("8500.00");

    // the two legs point at each other, so neither can be read alone
    const legs = (
      await pool.query(
        "SELECT * FROM ledger_vault_movements WHERE counterparty_type='vault' ORDER BY direction",
      )
    ).rows;
    expect(legs).toHaveLength(2);
    expect(legs[0].direction).toBe("in");
    expect(legs[1].direction).toBe("out");
    expect(legs[0].related_movement_id).toBe(legs[1].movement_id);
    expect(legs[1].related_movement_id).toBe(legs[0].movement_id);

    // a retry is a no-op on both sides
    const replay = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-1",
        toBranchId: OTHER_BRANCH,
        currency: "CAD",
        amount: "7500.00",
        reason: "armoured run",
      },
      cookies,
    });
    expect(replay.json().branches[DEMO.branchId].CAD).toBe("42500.00");
    expect(replay.json().branches[OTHER_BRANCH].CAD).toBe("8500.00");
  });

  it("refuses a run the operator has no business making", async () => {
    await reset([DEMO.branchId, OTHER_BRANCH]);
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);

    const toSelf = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-self",
        toBranchId: DEMO.branchId,
        currency: "CAD",
        amount: "10.00",
        reason: "nowhere",
      },
      cookies,
    });
    expect(toSelf.statusCode).toBe(422);

    // the receiving branch has never stated a position — refuse rather than
    // credit a strong room whose contents nobody has declared
    const untracked = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-untracked",
        toBranchId: OTHER_BRANCH,
        currency: "CAD",
        amount: "10.00",
        reason: "armoured run",
      },
      cookies,
    });
    expect(untracked.json().code).toBe("VAULT_NOT_INITIALIZED");

    await reset([DEMO.branchId]);
    const narrow = await cookie();
    await openVault({ CAD: "50000.00" }, narrow);
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-denied",
        toBranchId: OTHER_BRANCH,
        currency: "CAD",
        amount: "10.00",
        reason: "armoured run",
      },
      cookies: narrow,
    });
    expect(unauthorized.statusCode).toBe(403);
    expect(unauthorized.json().code).toBe("AUTHORIZATION_DENIED");
  });

  it("keeps vault movements append-only", async () => {
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);
    await float(cookies, {
      idempotencyKey: "issue-immutable",
      direction: "in",
      currency: "CAD",
      amount: "100.00",
    });
    await expect(
      pool.query("UPDATE ledger_vault_movements SET amount=1"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM ledger_vault_movements"),
    ).rejects.toThrow(/append-only/);
  });

  it("shows a teller the vault but does not let them move it", async () => {
    await pool.query(
      "UPDATE ledger_principals SET role='teller' WHERE user_id=$1||':a.singh'",
      [DEMO.tenantId],
    );
    await handle.db
      .update(schema.staffUsers)
      .set({ role: "teller" })
      .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
    const cookies = await cookie();
    expect((await vaultOf(cookies)).tracked).toBe(false);
    const denied = await openVault({ CAD: "10.00" }, cookies);
    expect(denied.statusCode).toBe(403);
  });
});
