/* ============================================================
   Cost moving with the cash, through the vault and the drawer.

   The ledger already refused to float a drawer from a strong room that did
   not have the money. It still moved that money as a bare quantity: the
   drawer's balance went up and nothing said what the cash had cost. The
   consequence is not a wrong balance, it is an unpriceable sale — the next
   trade out of that drawer either gets refused for a missing basis or books
   its entire proceeds as profit.

   A float, a return and an armoured run are TRANSFERS. The desk has sold
   nothing to anybody, so nothing is realized; what moves is the average,
   out of the sending box and into the receiving one. A delivery and a
   deposit are the boundary, and those DO have a price — the invoice coming
   in, the bank credit going out.

   Every case below is a way that could go wrong: a float landing with no
   basis, a transfer inventing a profit, an average taken against a balance
   that had already moved, a cost leg surviving a movement that was refused.
   ============================================================ */
import pg from "pg";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const OTHER_BRANCH = "br-cost-second";
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
    "TRUNCATE ledger_cost_events,ledger_vault_movements,ledger_vault_balances,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_till_balances,ledger_rates,ledger_principals CASCADE",
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
     VALUES ('cost-session-1',$1,$2,$3,$4,$5,1,current_date,'open',$1||':a.singh',now())`,
    scope,
  );
}

/** The desk's published board, which is the fallback price of last resort. */
async function publishRates() {
  await pool.query(
    `INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.731)
     ON CONFLICT DO NOTHING`,
    scope.slice(0, 4),
  );
}

const openVault = async (
  balances: Record<string, string>,
  cookies: Record<string, string>,
  unitCosts?: Record<string, string>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/vault/opening-position",
    payload: unitCosts ? { balances, unitCosts } : { balances },
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

const receipt = async (
  cookies: Record<string, string>,
  body: Record<string, unknown>,
) =>
  app.inject({
    method: "POST",
    url: "/api/ledger/vault/receipts",
    payload: { counterpartyRef: "Continental FX", reason: "order", ...body },
    cookies,
  });

/* Averages are read straight out of the balance rows: the response bodies
   carry quantity, and quantity is exactly the half of this that already
   worked. */
const tillAvg = async (currency: string) =>
  (
    await pool.query(
      "SELECT avg_cost FROM ledger_till_balances WHERE till_id='till-01' AND currency=$1",
      [currency],
    )
  ).rows[0]?.avg_cost ?? null;

const vaultAvg = async (currency: string, branchId = DEMO.branchId) =>
  (
    await pool.query(
      "SELECT avg_cost FROM ledger_vault_balances WHERE branch_id=$1 AND currency=$2",
      [branchId, currency],
    )
  ).rows[0]?.avg_cost ?? null;

const setTillAvg = (currency: string, avg: string) =>
  pool.query(
    "UPDATE ledger_till_balances SET avg_cost=$1 WHERE till_id='till-01' AND currency=$2",
    [avg, currency],
  );

const eventsOf = async (kind?: string) =>
  (
    await pool.query(
      kind
        ? "SELECT * FROM ledger_cost_events WHERE event_kind=$1 ORDER BY location_kind"
        : "SELECT * FROM ledger_cost_events ORDER BY location_kind",
      kind ? [kind] : [],
    )
  ).rows;

const at = (value: string | null, places = 6) =>
  value === null ? null : new Decimal(value).toFixed(places);

postgres("cost basis through the vault and the till", () => {
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
    /* Hand the database back empty. The suites share one, and the older
       ledger suites truncate the till tables without touching the vault —
       so a branch left holding USD and no CAD makes their next CAD float
       overdraw a strong room they never asked for. */
    await pool.query(
      "TRUNCATE ledger_cost_events,ledger_vault_movements,ledger_vault_balances CASCADE",
    );
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  it("states an opening position with a cost where the desk knows one", async () => {
    const cookies = await cookie();
    const opened = await openVault(
      { CAD: "50000.00", USD: "20000.00" },
      cookies,
      { USD: "1.35" },
    );
    expect(opened.statusCode).toBe(201);
    expect(opened.json().balances).toEqual({ CAD: "50000.00", USD: "20000.00" });
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");

    const events = await eventsOf();
    expect(events).toHaveLength(1);
    expect(events[0].event_kind).toBe("opening");
    expect(events[0].currency.trim()).toBe("USD");
    expect(events[0].location_kind).toBe("vault");
    // the home currency is the unit everything else is measured in; it has
    // no average to carry and never gains or loses against itself
    expect(await vaultAvg("CAD")).toBeNull();
  });

  it("still accepts an opening position with no costs, and invents none", async () => {
    const cookies = await cookie();
    // the shape every caller sends today, unchanged
    const opened = await openVault({ CAD: "50000.00", USD: "20000.00" }, cookies);
    expect(opened.statusCode).toBe(201);
    expect(opened.json().balances.USD).toBe("20000.00");

    /* A safe that predates the system holds real money whose price nobody
       recorded. Zero would claim it was free and the board mid would claim
       somebody paid it; both are worse than an unset basis that says so. */
    expect(await vaultAvg("USD")).toBeNull();
    expect(await eventsOf()).toHaveLength(0);
  });

  it("carries the vault's cost into the drawer when a float is issued", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.35" });
    await setTillAvg("USD", "1.40");

    const issued = await float(cookies, {
      idempotencyKey: "float-cost",
      direction: "in",
      currency: "USD",
      amount: "8000.00",
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().balances.USD).toBe("20000.00");      // 12,000 + 8,000
    expect(issued.json().vaultBalances.USD).toBe("12000.00"); // 20,000 − 8,000

    // 12,000 already there at 1.40, 8,000 arriving at the safe's 1.35
    expect(at(await tillAvg("USD"), 2)).toBe("1.38");
    // the sending average does not move — only what it holds does
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");
  });

  it("carries it back when the drawer returns cash at the end of a shift", async () => {
    const cookies = await cookie();
    await openVault({ USD: "10000.00" }, cookies, { USD: "1.30" });
    await pool.query(
      "UPDATE ledger_till_balances SET available_amount=20000, avg_cost=1.4 WHERE till_id='till-01' AND currency='USD'",
    );

    const returned = await float(cookies, {
      idempotencyKey: "return-cost",
      direction: "out",
      currency: "USD",
      amount: "10000.00",
      reason: "end of shift",
    });
    expect(returned.statusCode).toBe(201);
    expect(returned.json().balances.USD).toBe("10000.00");
    expect(returned.json().vaultBalances.USD).toBe("20000.00");

    // 10,000 at the safe's 1.30 blended with 10,000 arriving at the till's 1.40
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");
    expect(at(await tillAvg("USD"), 2)).toBe("1.40");
  });

  it("realizes nothing on a float or a return — a transfer is not a sale", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.35" });
    await setTillAvg("USD", "1.40");
    await float(cookies, {
      idempotencyKey: "float-nopnl",
      direction: "in",
      currency: "USD",
      amount: "5000.00",
    });
    await float(cookies, {
      idempotencyKey: "return-nopnl",
      direction: "out",
      currency: "USD",
      amount: "2000.00",
    });

    const moves = (
      await pool.query(
        "SELECT * FROM ledger_cost_events WHERE event_kind IN ('transfer_in','transfer_out')",
      )
    ).rows;
    expect(moves).toHaveLength(4);
    /* The desk moved its own cash between its own boxes. There are no
       proceeds because nobody paid it anything, and a realized figure
       computed against no proceeds would be a profit it did not make. */
    for (const move of moves) {
      expect(move.proceeds_home).toBeNull();
      expect(move.realized_pnl_home).toBeNull();
    }
    // and each leg names both ends, so the pair reads as one movement
    const out = moves.find((m) => m.event_kind === "transfer_out" && m.location_kind === "vault");
    const into = moves.find((m) => m.event_kind === "transfer_in" && m.location_kind === "till");
    expect(out.source_id).toBe(into.source_id);
    expect(at(out.unit_cost_home, 2)).toBe(at(into.unit_cost_home, 2));
  });

  it("prices a wholesale delivery at what it was invoiced", async () => {
    const cookies = await cookie();
    await openVault({ USD: "10000.00" }, cookies, { USD: "1.30" });

    const delivered = await receipt(cookies, {
      idempotencyKey: "delivery-priced",
      direction: "in",
      currency: "USD",
      amount: "10000.00",
      counterpartyType: "supplier",
      costHome: "14000.00",
    });
    expect(delivered.statusCode).toBe(201);
    expect(delivered.json().balances.USD).toBe("20000.00");

    // 10,000 held at 1.30, 10,000 delivered at 14,000 ÷ 10,000 = 1.40
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");
    const events = await eventsOf("delivery");
    expect(events).toHaveLength(1);
    expect(at(events[0].unit_cost_home, 2)).toBe("1.40");
    expect(events[0].realized_pnl_home).toBeNull(); // buying earns nothing
  });

  it("leaves the basis alone when a delivery arrives before its invoice", async () => {
    const cookies = await cookie();
    await openVault({ USD: "10000.00" }, cookies, { USD: "1.30" });

    await receipt(cookies, {
      idempotencyKey: "delivery-unpriced",
      direction: "in",
      currency: "USD",
      amount: "10000.00",
      counterpartyType: "supplier",
    });
    /* Nothing is guessed: the cash carries the average already in the safe,
       which by construction leaves that average exactly where it was. The
       event is still written, because a quantity that moved with no event
       behind it is a basis nobody can explain afterwards. */
    expect(at(await vaultAvg("USD"), 2)).toBe("1.30");
    const events = await eventsOf("delivery");
    expect(events).toHaveLength(1);
    expect(at(events[0].unit_cost_home, 2)).toBe("1.30");
  });

  it("realizes a bank deposit against what the cash cost", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.30" });

    const banked = await receipt(cookies, {
      idempotencyKey: "deposit-priced",
      direction: "out",
      currency: "USD",
      amount: "10000.00",
      counterpartyType: "bank",
      counterpartyRef: "RBC 0142",
      costHome: "14000.00",
    });
    expect(banked.statusCode).toBe(201);
    expect(banked.json().balances.USD).toBe("10000.00");

    /* Cash that leaves the desk for good is a disposal wherever it goes.
       10,000 units that cost 1.30 fetched 14,000 — the desk made 1,000, and
       the average of what is left does not move. */
    const events = await eventsOf("withdrawal");
    expect(events).toHaveLength(1);
    expect(events[0].proceeds_home).toBe("14000.00");
    expect(events[0].realized_pnl_home).toBe("1000.00");
    expect(at(await vaultAvg("USD"), 2)).toBe("1.30");
  });

  it("moves cost between branches on an armoured run", async () => {
    await reset([DEMO.branchId, OTHER_BRANCH]);
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.30" });
    await pool.query(
      "INSERT INTO ledger_vault_balances (tenant_id,legal_entity_id,branch_id,currency,available_amount,avg_cost) VALUES ($1,$2,$3,'USD',10000,1.5)",
      [DEMO.tenantId, DEMO.legalEntityId, OTHER_BRANCH],
    );

    const run = await app.inject({
      method: "POST",
      url: "/api/ledger/vault/runs",
      payload: {
        idempotencyKey: "run-cost",
        toBranchId: OTHER_BRANCH,
        currency: "USD",
        amount: "10000.00",
        reason: "armoured run",
      },
      cookies,
    });
    expect(run.statusCode).toBe(201);
    expect(run.json().branches[DEMO.branchId].USD).toBe("10000.00");
    expect(run.json().branches[OTHER_BRANCH].USD).toBe("20000.00");

    // the sending safe keeps its average; the receiving one blends
    // 10,000 of its own at 1.50 with 10,000 arriving at 1.30
    expect(at(await vaultAvg("USD"), 2)).toBe("1.30");
    expect(at(await vaultAvg("USD", OTHER_BRANCH), 2)).toBe("1.40");

    // a run is a transfer between the desk's own strong rooms: no P&L
    for (const event of await eventsOf("transfer_out")) {
      expect(event.realized_pnl_home).toBeNull();
    }
  });

  it("falls back to the published board rate, and says the basis was estimated", async () => {
    const cookies = await cookie();
    await publishRates();
    // an opening position stated without a cost — the safe predates all this
    await openVault({ USD: "20000.00" }, cookies);
    await pool.query(
      "DELETE FROM ledger_till_balances WHERE till_id='till-01' AND currency='USD'",
    );

    await float(cookies, {
      idempotencyKey: "float-estimated",
      direction: "in",
      currency: "USD",
      amount: "5000.00",
    });

    /* 0.731 USD to the Canadian dollar is 1.367989… a dollar. It is the only
       price on this server anybody stood behind, and the event carries the
       label so a basis still resting on it can be found and corrected. */
    const estimated = await eventsOf("opening_estimated");
    expect(estimated).toHaveLength(1);
    expect(estimated[0].location_kind).toBe("vault");
    expect(at(await tillAvg("USD"))).toBe("1.367989");
    expect(at(await vaultAvg("USD"))).toBe("1.367989");
  });

  it("moves the cash without a cost leg rather than invent a price", async () => {
    const cookies = await cookie();
    // no board published for USD at this branch, and no stated opening cost
    await openVault({ USD: "20000.00" }, cookies);

    const issued = await float(cookies, {
      idempotencyKey: "float-unpriced",
      direction: "in",
      currency: "USD",
      amount: "5000.00",
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().balances.USD).toBe("17000.00");
    expect(issued.json().vaultBalances.USD).toBe("15000.00");

    /* There is nothing honest to carry, so nothing is carried. An absent
       basis is a state somebody can find and fix; a fabricated one is a
       number that will be believed. */
    expect(await eventsOf()).toHaveLength(0);
    expect(await tillAvg("USD")).toBeNull();
    expect(await vaultAvg("USD")).toBeNull();
  });

  it("leaves the home currency out of it entirely", async () => {
    const cookies = await cookie();
    await openVault({ CAD: "50000.00" }, cookies);
    await float(cookies, {
      idempotencyKey: "float-home",
      direction: "in",
      currency: "CAD",
      amount: "5000.00",
    });
    /* Canadian dollars cost a Canadian dollar each. There is no average to
       carry and no margin to realize against the unit of measurement. */
    expect(await eventsOf()).toHaveLength(0);
    expect(await tillAvg("CAD")).toBeNull();
  });

  it("writes no cost for a movement that was refused", async () => {
    const cookies = await cookie();
    await openVault({ USD: "1000.00" }, cookies, { USD: "1.35" });

    const tooMuch = await float(cookies, {
      idempotencyKey: "float-overdraw",
      direction: "in",
      currency: "USD",
      amount: "5000.00",
    });
    expect(tooMuch.statusCode).toBe(422);
    expect(tooMuch.json().code).toBe("INSUFFICIENT_VAULT_LIQUIDITY");

    /* Cost and quantity move in the same transaction, so a refused movement
       leaves neither behind. A second pass that wrote the cost after the
       quantity had rolled back is exactly the failure this avoids. */
    expect(await eventsOf("transfer_out")).toHaveLength(0);
    expect(await eventsOf("transfer_in")).toHaveLength(0);
    expect(await tillAvg("USD")).toBeNull();
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");
  });

  it("does not carry the cost twice when a float is retried", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.35" });
    await setTillAvg("USD", "1.40");
    const body = {
      idempotencyKey: "float-retry",
      direction: "in",
      currency: "USD",
      amount: "8000.00",
    };
    await float(cookies, body);
    await float(cookies, body);

    expect(await eventsOf("transfer_in")).toHaveLength(1);
    expect(at(await tillAvg("USD"), 2)).toBe("1.38");
    expect(at(await vaultAvg("USD"), 2)).toBe("1.35");
  });

  it("keeps a cost event append-only once it is written", async () => {
    const cookies = await cookie();
    await openVault({ USD: "20000.00" }, cookies, { USD: "1.35" });
    await expect(
      pool.query("UPDATE ledger_cost_events SET unit_cost_home=9"),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM ledger_cost_events"),
    ).rejects.toThrow(/append-only/);
  });
});
