/* Ruling C4 item 4 (cheque-rulings-2026-10-24.md). A typed type and
   number is not a current government photo ID. The server sets
   standing. A browser verified flag is refused. A stored verified
   column does not waive a cheque at CAD 4,000.00.

   Fail closed until the catalogue PR: only a current photo ID that
   the shared list requires an expiry for counts as Identified. A
   Citizenship Card is a no-expiry type, so it does not count. A
   birth certificate is not used here. It is not an ID document. */
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
let pool: pg.Pool, app: FastifyInstance, handle: DbHandle;

const TILL = "till-01";
const scope = [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, TILL];

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
    "TRUNCATE ledger_cheque_events,ledger_cheques,ledger_vault_balances,ledger_vault_movements,ledger_cost_lot_consumption,ledger_cost_lots,ledger_cost_events,quote_events,quote_overrides,quotes,ledger_operational_cash_movements,ledger_till_counts,ledger_till_count_batches,ledger_till_sessions,ledger_audit_events,ledger_reversal_entries,ledger_reversals,ledger_till_movements,ledger_journal_entries,ledger_transactions,ledger_idempotency,ledger_till_balances,ledger_rates,ledger_customers,ledger_principals CASCADE",
  );
  await pool.query("DELETE FROM desk_client_identity_documents WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query("DELETE FROM desk_clients WHERE tenant_id=$1", [DEMO.tenantId]);
  await pool.query(
    "INSERT INTO tenants (id,name) VALUES ($1,'York FX') ON CONFLICT DO NOTHING",
    [DEMO.tenantId],
  );
  await pool.query(
    `INSERT INTO legal_entities (id,tenant_id,name,home_currency,jurisdiction_pack_id,jurisdiction_pack_version)
     VALUES ($1,$2,'York FX Canada','CAD','pack-ca-v1',1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id='pack-ca-v1', home_currency='CAD'`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id,tenant_id,legal_entity_id,name) VALUES ($1,$2,$3,'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1||':a.singh',$1,$2,$3,$4,$5,'branch_manager',$6)`,
    [...scope, JSON.stringify([DEMO.branchId])],
  );
  await handle.db
    .update(schema.staffUsers)
    .set({ role: "branch_manager", authorizedBranchIds: [DEMO.branchId] })
    .where(eq(schema.staffUsers.id, `${DEMO.tenantId}:a.singh`));
  await pool.query(
    "INSERT INTO ledger_till_balances (tenant_id,legal_entity_id,branch_id,workspace_id,till_id,currency,available_amount) VALUES ($1,$2,$3,$4,$5,'CAD',5000)",
    scope,
  );
  await pool.query(
    `INSERT INTO ledger_till_sessions
      (session_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,
       session_number,business_date,status,opened_by,opened_at)
     VALUES ('chq-typed-session',$1,$2,$3,$4,$5,1,DATE '2026-06-18','open',$1||':a.singh',now())`,
    scope,
  );
}

/* Column says verified. The only paper is a typed type and number
   that is not a current government photo ID. */
async function fileTypedOnly(customerId: string, clientId: string, name: string) {
  await pool.query(
    `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
     VALUES ($1,$2,$3,$4)`,
    [clientId, DEMO.tenantId, DEMO.legalEntityId, name],
  );
  await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id,
        doc_type, doc_number, expires_on, is_primary)
     VALUES ($1,$2,$3,$4,'Library card','LC-100',DATE '2032-04-01',true)`,
    [`doc-${clientId}`, clientId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    `INSERT INTO ledger_customers
       (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified',$7)`,
    [customerId, ...scope.slice(0, 4), name, clientId],
  );
}

async function fileDocument(
  customerId: string,
  clientId: string,
  name: string,
  docType: string,
  docNumber: string,
  expiresOn: string,
) {
  await pool.query(
    `INSERT INTO desk_clients (client_id, tenant_id, legal_entity_id, display_name)
     VALUES ($1,$2,$3,$4)`,
    [clientId, DEMO.tenantId, DEMO.legalEntityId, name],
  );
  await pool.query(
    `INSERT INTO desk_client_identity_documents
       (document_id, client_id, tenant_id, legal_entity_id,
        doc_type, doc_number, expires_on, is_primary)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,true)`,
    [`doc-${clientId}`, clientId, DEMO.tenantId, DEMO.legalEntityId, docType, docNumber, expiresOn],
  );
  await pool.query(
    `INSERT INTO ledger_customers
       (customer_id,tenant_id,legal_entity_id,branch_id,workspace_id,name,risk,id_status,client_id)
     VALUES ($1,$2,$3,$4,$5,$6,'Normal','verified',$7)`,
    [customerId, ...scope.slice(0, 4), name, clientId],
  );
}

async function standingOf(customerId: string) {
  const cookies = await cookie();
  const listed = await app.inject({ method: "GET", url: "/api/ledger/customers", cookies });
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json().customers.find(
    (item: { customerId: string }) => item.customerId === customerId,
  );
}

async function cashFourThousand(customerId: string, key: string) {
  const cookies = await cookie();
  return app.inject({
    method: "POST",
    url: "/api/ledger/cheques",
    cookies,
    payload: {
      idempotencyKey: key,
      customerId,
      chequeNumber: "004821",
      maker: "Northbridge Imports Ltd.",
      draweeBank: "RBC Royal Bank",
      chequeType: "business",
      typeLabel: "Business",
      currency: "CAD",
      faceAmount: "4000.00",
      feeAmount: "35.00",
      holdDays: 0,
      endorsed: true,
    },
  });
}

async function tillCad() {
  const row = await pool.query(
    "SELECT available_amount FROM ledger_till_balances WHERE till_id=$1 AND currency='CAD'",
    [TILL],
  );
  return String(row.rows[0].available_amount);
}

postgres("typed ID is not Identified on a cheque", () => {
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
    await pool.query("DELETE FROM tenant_state WHERE tenant_id=$1", [DEMO.tenantId]);
    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    await pool.query("TRUNCATE ledger_cheque_events,ledger_cheques CASCADE");
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.LEDGER_DATABASE_URL;
  });

  beforeEach(async () => {
    await reset();
  });

  it("refuses a browser-sent verified flag and does not store it", async () => {
    const cookies = await cookie();
    const created = await app.inject({
      method: "POST",
      url: "/api/ledger/customers",
      cookies,
      payload: { name: "Browser Verified", risk: "normal", idStatus: "verified" },
    });
    expect(created.statusCode, created.body).toBe(422);
    expect(created.json().code).toBe("ID_STATUS_NOT_CLIENT_SET");
    const stored = await pool.query(
      "SELECT id_status FROM ledger_customers WHERE name='Browser Verified'",
    );
    expect(stored.rowCount).toBe(0);
  });

  it("does not call a typed type and number Identified", async () => {
    await fileTypedOnly("customer-typed", "cli-typed", "Ada Typed");
    const row = await standingOf("customer-typed");
    expect(row.idStatus).toBe("missing");
    expect(row.idStanding.label).toBe("Missing ID");
    expect(row.idStanding.status).not.toBe("identified");
  });

  it("reads an expired driver's licence as Expired", async () => {
    await fileDocument(
      "customer-expired",
      "cli-expired",
      "Ada Expired",
      "Driver's Licence",
      "D1234567",
      "2020-01-01",
    );
    const row = await standingOf("customer-expired");
    expect(row.idStatus).toBe("expired");
    expect(row.idStanding.label).toBe("Expired");
    expect(row.idStanding.status).not.toBe("identified");
  });

  it("does not call a Citizenship Card Identified", async () => {
    await fileDocument(
      "customer-citizen",
      "cli-citizen",
      "Ada Citizen",
      "Citizenship Card",
      "CC-8821",
      "2032-04-01",
    );
    const row = await standingOf("customer-citizen");
    expect(row.idStatus).toBe("missing");
    expect(row.idStanding.label).toBe("Missing ID");
    expect(row.idStanding.status).not.toBe("identified");
  });

  it("calls a current driver's licence Identified", async () => {
    await fileDocument(
      "customer-current",
      "cli-current",
      "Ada Current",
      "Driver's Licence",
      "D7654321",
      "2032-04-01",
    );
    const row = await standingOf("customer-current");
    expect(row.idStatus).toBe("verified");
    expect(row.idStanding.label).toBe("Identified");
    expect(row.idStanding.status).toBe("identified");
  });

  it("does not let a stored verified column waive the cheque ID check", async () => {
    await fileTypedOnly("customer-typed", "cli-typed", "Ada Typed");
    const refused = await cashFourThousand("customer-typed", "typed-4000");
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().code).toBe("COMPLIANCE_BLOCKED");
    expect(await tillCad()).toBe("5000.00");
    const cheques = await pool.query("SELECT count(*)::int AS n FROM ledger_cheques");
    expect(cheques.rows[0].n).toBe(0);
  });
});
