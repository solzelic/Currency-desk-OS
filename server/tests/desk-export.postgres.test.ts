/* The owner download. A manager is refused. Another desk's row is not
   in the file. A cheque clearing row is not a deal. Money stays the
   numeric text that was stored. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
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

postgres("owner desk export", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SEED_PASSWORD = "yorkville";
    handle = await createDb();
    pool = new pg.Pool({ connectionString: url });
    await seed(handle.db);

    await pool.query(
      `INSERT INTO tenants (id, name) VALUES ('tnt-export-other', 'Other desk') ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO legal_entities (id, tenant_id, name, home_currency)
       VALUES ('le-export-other', 'tnt-export-other', 'Other', 'CAD') ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO branches (id, tenant_id, legal_entity_id, name)
       VALUES ('br-export-other', 'tnt-export-other', 'le-export-other', 'Other') ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, legal_entity_id, branch_id, till_id)
       VALUES ('ws-export-other', 'tnt-export-other', 'le-export-other', 'br-export-other', 'till-other')
       ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO workspaces (id, tenant_id, legal_entity_id, branch_id, till_id)
       VALUES ('ws-export-till-2', $1, $2, $3, 'till-export-2')
       ON CONFLICT DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
    );
    await pool.query(
      `INSERT INTO ledger_customers
         (customer_id, tenant_id, legal_entity_id, branch_id, workspace_id, name, risk, id_status)
       VALUES
         ('cust-export-zed', $1, $2, $3, $4, 'Zed Customer', 'normal', 'verified'),
         ('cust-export-other', 'tnt-export-other', 'le-export-other', 'br-export-other', 'ws-export-other', 'Should Not Leak', 'normal', 'verified')
       ON CONFLICT DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId],
    );
    await pool.query(
      `INSERT INTO desk_clients
         (client_id, tenant_id, legal_entity_id, display_name, date_of_birth)
       VALUES
         ('cli-export-zed', $1, $2, 'Zed, Export', '1984-03-02'),
         ('cli-export-other', 'tnt-export-other', 'le-export-other', 'Should Not Leak', '1990-01-01')
       ON CONFLICT (client_id) DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query(
      `INSERT INTO desk_client_identity_documents
         (document_id, client_id, tenant_id, legal_entity_id, doc_type, doc_number, is_primary)
       VALUES ('doc-export-zed', 'cli-export-zed', $1, $2, 'passport', 'AB,12', true)
       ON CONFLICT DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId],
    );
    await pool.query(
      `INSERT INTO ledger_transactions
         (transaction_id, transaction_ref, tenant_id, legal_entity_id, branch_id, workspace_id, till_id,
          customer_id, actor_id, from_currency, to_currency, input_amount, output_amount, rate,
          fee_cad, spread_cad, purpose, source_of_funds, posted_at, deal_kind,
          received_instrument, disbursed_instrument, home_currency)
       VALUES
         ('tx-export-zed', 'REF-EXPORT-ZED', $1, $2, $3, $4, 'till-01',
          'cust-export-zed', $5, 'CAD', 'USD', 1000.50, 730.00, 1.370000000000,
          2.00, 0, 'travel', 'salary', now(), 'exchange', 'cash', 'cash', 'CAD'),
         ('tx-export-till-2', 'REF-EXPORT-TILL-2', $1, $2, $3, 'ws-export-till-2', 'till-export-2',
          'cust-export-zed', $5, 'CAD', 'USD', 10.00, 7.00, 1.370000000000,
          0, 0, 'travel', 'salary', now(), 'exchange', 'cash', 'cash', 'CAD'),
         ('tx-export-clearing', 'REF-EXPORT-CLEARING', $1, $2, $3, $4, 'till-01',
          'cust-export-zed', $5, 'CAD', 'CAD', 50.00, 50.00, 1,
          0, 0, 'travel', 'salary', now(), 'cheque_clearing', 'cash', 'cash', 'CAD'),
         ('tx-export-other', 'REF-EXPORT-OTHER', 'tnt-export-other', 'le-export-other', 'br-export-other', 'ws-export-other', 'till-other',
          'cust-export-other', 'nobody', 'CAD', 'USD', 9.00, 6.00, 1,
          0, 0, 'travel', 'salary', now(), 'exchange', 'cash', 'cash', 'CAD')
       ON CONFLICT DO NOTHING`,
      [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId, DEMO.workspaceId, `${DEMO.tenantId}:j.masri`],
    );

    app = await buildApp(handle.db);
  });

  afterAll(async () => {
    /* Ledger rows are append-only. They stay. The ids are stable, and a
       second run of this file uses ON CONFLICT so it does not insert
       them again. Clients are not append-only, so those rows go. */
    await pool.query(
      `DELETE FROM desk_client_identity_documents WHERE document_id IN ('doc-export-zed')`,
    );
    await pool.query(`DELETE FROM desk_clients WHERE client_id IN ('cli-export-zed', 'cli-export-other')`);
    await app.close();
    await handle.close();
    await pool.end();
    delete process.env.DATABASE_URL;
  });

  const login = async (staffId: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId, password: "yorkville", tenantId: DEMO.tenantId },
    });
    expect(res.statusCode).toBe(200);
    return cookieOf(res);
  };

  it("refuses a stranger and a manager", async () => {
    const stranger = await app.inject({ method: "GET", url: "/api/desk/export/clients.csv" });
    expect(stranger.statusCode).toBe(401);
    expect(stranger.json().message).toMatch(/Sign in again/);

    const manager = await login("r.haddad");
    const refused = await app.inject({ method: "GET", url: "/api/desk/export/deals.csv", cookies: manager });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toMatch(/Only the owner/);
  });

  it("gives the owner this desk's clients and deals, and nobody else's", async () => {
    const owner = await login("j.masri");
    const clients = await app.inject({ method: "GET", url: "/api/desk/export/clients.csv", cookies: owner });
    expect(clients.statusCode).toBe(200);
    expect(clients.headers["content-type"]).toMatch(/text\/csv/);
    expect(clients.body).toContain('"Zed, Export"');
    expect(clients.body).toContain('"AB,12"');
    expect(clients.body).toContain("1984-03-02");
    expect(clients.body).not.toContain("Should Not Leak");

    const deals = await app.inject({ method: "GET", url: "/api/desk/export/deals.csv", cookies: owner });
    expect(deals.statusCode).toBe(200);
    expect(deals.body).toContain("REF-EXPORT-ZED");
    expect(deals.body).toContain("REF-EXPORT-TILL-2");
    expect(deals.body).not.toContain("REF-EXPORT-CLEARING");
    expect(deals.body).not.toContain("REF-EXPORT-OTHER");
    const zed = deals.body.split("\n").find((line) => line.includes("REF-EXPORT-ZED"));
    expect(zed).toBeTruthy();
    const amount = zed!.split(",")[8];
    expect(new Decimal(amount!).eq("1000.50")).toBe(true);
    expect(amount).not.toMatch(/1000\.499/);
  });
});
