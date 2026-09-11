/* Product-demo seeder posts through the real quote / ledger / client
   services, only on York FX, and is a no-op the second time. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { populateDemoDesk } from "../src/demo-desk.js";
import { LedgerService, type LedgerActor } from "../src/ledger/service.js";
import { eq } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

let handle: DbHandle;
let pool: pg.Pool;

const OTHER = {
  tenantId: "tnt-not-demo",
  legalEntityId: "le-not-demo",
  branchId: "br-not-demo",
  workspaceId: "ws-not-demo-till-01",
  tillId: "till-01",
};

const otherActor: LedgerActor = {
  userId: "tnt-not-demo:other.teller",
  tenantId: OTHER.tenantId,
  legalEntityId: OTHER.legalEntityId,
  branchId: OTHER.branchId,
  workspaceId: OTHER.workspaceId,
  tillId: OTHER.tillId,
  role: "teller",
  authorizedBranchIds: [OTHER.branchId],
};

async function resetDemoBook() {
  await pool.query(
    `TRUNCATE
       desk_client_images,
       desk_client_identity_documents,
       desk_client_aliases,
       desk_clients,
       ledger_vault_balances,
       ledger_vault_movements,
       ledger_cost_lot_consumption,
       ledger_cost_lots,
       ledger_cost_events,
       quote_events,
       quote_overrides,
       quotes,
       ledger_operational_cash_movements,
       ledger_till_counts,
       ledger_till_count_batches,
       ledger_till_sessions,
       ledger_audit_events,
       ledger_reversal_entries,
       ledger_reversals,
       ledger_till_movements,
       ledger_journal_entries,
       ledger_transactions,
       ledger_idempotency,
       ledger_till_balances,
       ledger_rates,
       ledger_customers,
       ledger_principals
     CASCADE`,
  );
  await seed(handle.db);
}

async function countFor(tenantId: string, table: string) {
  const result = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  return result.rows[0].n as number;
}

async function seedForeignTenantDeal() {
  await pool.query("INSERT INTO tenants (id,name,site_slug) VALUES ($1,'Not Demo','notdemo') ON CONFLICT DO NOTHING", [
    OTHER.tenantId,
  ]);
  await pool.query(
    `INSERT INTO legal_entities
       (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'Not Demo Inc','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1'`,
    [OTHER.legalEntityId, OTHER.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Other Desk') ON CONFLICT DO NOTHING",
    [OTHER.branchId, OTHER.tenantId, OTHER.legalEntityId],
  );
  await pool.query(
    "INSERT INTO workspaces (id,tenant_id,legal_entity_id,branch_id,till_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    [OTHER.workspaceId, OTHER.tenantId, OTHER.legalEntityId, OTHER.branchId, OTHER.tillId],
  );
  const scope = [OTHER.tenantId, OTHER.legalEntityId, OTHER.branchId, OTHER.workspaceId, OTHER.tillId];
  await pool.query(
    "INSERT INTO ledger_principals VALUES ($1,$2,$3,$4,$5,$6,'teller',$7) ON CONFLICT DO NOTHING",
    [otherActor.userId, ...scope, JSON.stringify([OTHER.branchId])],
  );
  await pool.query(
    "INSERT INTO ledger_customers VALUES ('customer-other',$1,$2,$3,$4,'Other Customer','Normal','verified') ON CONFLICT DO NOTHING",
    scope.slice(0, 4),
  );
  await pool.query(
    "INSERT INTO ledger_rates VALUES ($1,$2,$3,$4,'CAD',1),($1,$2,$3,$4,'USD',0.731) ON CONFLICT DO NOTHING",
    scope.slice(0, 4),
  );
  for (const [currency, value] of [
    ["CAD", 25000],
    ["USD", 12000],
  ]) {
    await pool.query("INSERT INTO ledger_till_balances VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [
      ...scope,
      currency,
      value,
    ]);
  }
  await pool.query(
    `INSERT INTO ledger_till_sessions
       (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
        session_number,business_date,status,opened_by,opened_at)
     VALUES ('session-other',$1,$2,$3,$4,$5,1,current_date,'open',$6,now())
     ON CONFLICT DO NOTHING`,
    [...scope, otherActor.userId],
  );
  const service = new LedgerService(pool);
  return service.post(otherActor, {
    idempotencyKey: "other-tenant-only",
    customerId: "customer-other",
    from: "CAD",
    to: "USD",
    inputAmount: "80.00",
    feeCad: "1.00",
    purpose: "Personal",
    sourceOfFunds: "Cash",
  });
}

postgres("York FX demo desk seeder", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await seed(handle.db);
  });
  afterAll(async () => {
    await handle.close();
    await pool.end();
  });
  beforeEach(resetDemoBook);

  it("posts a lived-in book through the quote path and is a no-op the second time", async () => {
    const first = await populateDemoDesk(pool, handle.db);
    expect(first.status).toBe("populated");
    expect(first.customers).toBe(4);
    expect(first.posted).toBe(6);
    expect(first.reused).toBe(0);
    expect(first.tillOpen).toBe(true);
    expect(first.transactions).toBeGreaterThanOrEqual(6);

    const deals = await pool.query(
      `SELECT from_currency, to_currency, input_amount, purpose
         FROM ledger_transactions
        WHERE tenant_id=$1 AND legal_entity_id=$2 AND workspace_id=$3
        ORDER BY posted_at, transaction_id`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.workspaceId],
    );
    expect(deals.rowCount).toBe(6);
    expect(deals.rows.map((row) => `${row.from_currency.trim()}→${row.to_currency.trim()}`)).toEqual([
      "USD→CAD",
      "CAD→USD",
      "CAD→EUR",
      "CAD→USD",
      "EUR→CAD",
      "CAD→EUR",
    ]);

    const journal = await pool.query(
      `SELECT t.transaction_id, sum(CASE WHEN e.side='debit' THEN e.amount_cad ELSE 0 END) AS debit,
              sum(CASE WHEN e.side='credit' THEN e.amount_cad ELSE 0 END) AS credit
         FROM ledger_transactions t
         JOIN ledger_journal_entries e ON e.transaction_id=t.transaction_id
        WHERE t.tenant_id=$1
        GROUP BY t.transaction_id`,
      [DEMO.tenantId],
    );
    for (const row of journal.rows) {
      expect(row.debit).toBe(row.credit);
    }

    const clients = await pool.query("SELECT display_name FROM desk_clients WHERE tenant_id=$1 ORDER BY display_name", [
      DEMO.tenantId,
    ]);
    expect(clients.rows.map((row) => row.display_name)).toEqual([
      "James Okonkwo",
      "Lina Farah",
      "Omar Haddad",
      "Priya Nair",
    ]);

    const till = await pool.query(
      `SELECT status FROM ledger_till_sessions
        WHERE tenant_id=$1 AND workspace_id=$2
        ORDER BY session_number DESC LIMIT 1`,
      [DEMO.tenantId, DEMO.workspaceId],
    );
    expect(till.rows[0].status).toBe("open");

    const second = await populateDemoDesk(pool, handle.db);
    expect(second.status).toBe("already");
    expect(second.posted).toBe(0);
    expect(second.reused).toBe(6);
    expect(second.customers).toBe(4);
    expect((await pool.query("SELECT count(*)::int AS n FROM ledger_transactions WHERE tenant_id=$1", [DEMO.tenantId])).rows[0].n).toBe(6);
    expect((await pool.query("SELECT count(*)::int AS n FROM desk_clients WHERE tenant_id=$1", [DEMO.tenantId])).rows[0].n).toBe(4);
  });

  it("does not write customers, sessions, or transactions on any other tenant", async () => {
    const foreign = await seedForeignTenantDeal();
    expect(foreign.transactionId).toBeTruthy();

    const before = {
      transactions: await countFor(OTHER.tenantId, "ledger_transactions"),
      customers: await countFor(OTHER.tenantId, "ledger_customers"),
      sessions: await countFor(OTHER.tenantId, "ledger_till_sessions"),
      clients: await countFor(OTHER.tenantId, "desk_clients"),
      quotes: await countFor(OTHER.tenantId, "quotes"),
      principals: await countFor(OTHER.tenantId, "ledger_principals"),
    };
    expect(before.transactions).toBe(1);
    expect(before.customers).toBe(1);

    const result = await populateDemoDesk(pool, handle.db);
    expect(result.status).toBe("populated");
    expect(result.posted).toBe(6);

    expect(await countFor(OTHER.tenantId, "ledger_transactions")).toBe(before.transactions);
    expect(await countFor(OTHER.tenantId, "ledger_customers")).toBe(before.customers);
    expect(await countFor(OTHER.tenantId, "ledger_till_sessions")).toBe(before.sessions);
    expect(await countFor(OTHER.tenantId, "desk_clients")).toBe(before.clients);
    expect(await countFor(OTHER.tenantId, "quotes")).toBe(before.quotes);
    expect(await countFor(OTHER.tenantId, "ledger_principals")).toBe(before.principals);

    const foreignTx = await pool.query(
      "SELECT transaction_id, input_amount FROM ledger_transactions WHERE tenant_id=$1",
      [OTHER.tenantId],
    );
    expect(foreignTx.rows).toEqual([{ transaction_id: foreign.transactionId, input_amount: "80.00" }]);
  });

  it("still posts when a prior suite left the demo entity on another home currency", async () => {
    await pool.query(
      `UPDATE legal_entities
          SET home_currency='GBP', jurisdiction_pack_id='pack-gb-v1'
        WHERE id=$1 AND tenant_id=$2`,
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    const first = await populateDemoDesk(pool, handle.db);
    expect(first.status).toBe("populated");
    expect(first.posted).toBe(6);
    const home = await pool.query(
      "SELECT home_currency, jurisdiction_pack_id FROM legal_entities WHERE id=$1 AND tenant_id=$2",
      [DEMO.legalEntityId, DEMO.tenantId],
    );
    expect(home.rows[0]).toEqual({ home_currency: "CAD", jurisdiction_pack_id: "pack-ca-v1" });
  });

  it("skips when York FX is no longer the demo site", async () => {
    await handle.db.update(schema.tenants).set({ siteSlug: "renamed" }).where(eq(schema.tenants.id, DEMO.tenantId));
    try {
      const skipped = await populateDemoDesk(pool, handle.db);
      expect(skipped).toMatchObject({ status: "skipped", reason: "not-demo-tenant", posted: 0 });
      expect(await countFor(DEMO.tenantId, "ledger_transactions")).toBe(0);
    } finally {
      await handle.db.update(schema.tenants).set({ siteSlug: "yorkfx" }).where(eq(schema.tenants.id, DEMO.tenantId));
    }
  });
});
