/* Self-test for the route sweep helper. Nothing else calls it yet.
   On 2026-10-25 the app listed 69 GET routes. 64 leaves a small margin. */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, provisionPostgres, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { fillRoute, listGetRoutes, seedSweepFixture, SWEEP_CUSTOMER, type SweepIds } from "./helpers/route-sweep.js";

const MIN_GET_ROUTES = 64;
const ledgerUrl = process.env.TEST_DATABASE_URL;

let handle: DbHandle;
let app: FastifyInstance;
let pool: pg.Pool;

async function session(staffId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId: DEMO.tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

beforeAll(async () => {
  expect(ledgerUrl, "TEST_DATABASE_URL").toBeTruthy();
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.LEDGER_DATABASE_URL = ledgerUrl;
  handle = await createDb();
  await seed(handle.db);
  pool = await provisionPostgres(ledgerUrl!);
  await pool.query("INSERT INTO tenants (id, name) VALUES ($1, 'York FX') ON CONFLICT DO NOTHING", [DEMO.tenantId]);
  await pool.query(
    `INSERT INTO legal_entities (id, tenant_id, name, jurisdiction, home_currency, jurisdiction_pack_id, jurisdiction_pack_version)
     VALUES ($1, $2, 'York FX', 'FINTRAC', 'CAD', 'pack-ca-v1', 1)
     ON CONFLICT (id) DO UPDATE SET jurisdiction_pack_id = 'pack-ca-v1', home_currency = 'CAD', jurisdiction_pack_version = 1`,
    [DEMO.legalEntityId, DEMO.tenantId],
  );
  await pool.query(
    "INSERT INTO branches (id, tenant_id, legal_entity_id, name) VALUES ($1, $2, $3, 'Yorkville') ON CONFLICT DO NOTHING",
    [DEMO.branchId, DEMO.tenantId, DEMO.legalEntityId],
  );
  await pool.query(
    "INSERT INTO market_rates (id, provider, mids, fetched_at) VALUES ('sweep-snap', 'test', '{\"USD\":1.4}', now()) ON CONFLICT (id) DO UPDATE SET fetched_at = now()",
  );
  await pool.query(
    `INSERT INTO rate_boards (id, tenant_id, legal_entity_id, branch_id, buy_margin, sell_margin, board_rows, market_snapshot_id, published_by, published_at)
     VALUES ('sweep-board', $1, $2, $3, 0.02, 0.03, '{"USD":{"mid":1.4,"show":true}}', 'sweep-snap', 'seed', now())
     ON CONFLICT (id) DO UPDATE SET published_at = now(), board_rows = EXCLUDED.board_rows`,
    [DEMO.tenantId, DEMO.legalEntityId, DEMO.branchId],
  );
  app = await buildApp(handle.db);
}, 60_000);

afterAll(async () => {
  if (pool) {
    await pool.query("DELETE FROM rate_boards WHERE id = 'sweep-board'");
    await pool.query("DELETE FROM market_rates WHERE id = 'sweep-snap'");
  }
  await app?.close();
  await handle?.close();
  await pool?.end();
  delete process.env.LEDGER_DATABASE_URL;
});

describe("route sweep helper", () => {
  it("lists GET routes, seeds the fixture, and fills every param", async () => {
    const routes = listGetRoutes(app);
    expect(routes, "listed " + routes.length).toEqual(
      expect.arrayContaining(["/api/tenant/state", "/api/clients/:clientId"]),
    );
    expect(routes.length, "GET routes").toBeGreaterThanOrEqual(MIN_GET_ROUTES);

    const ids: SweepIds = await seedSweepFixture(app, pool);
    const admin = await session("j.masri");
    const client = await app.inject({ method: "GET", url: "/api/clients/" + ids.clientId, cookies: admin });
    expect(client.statusCode, client.body).toBe(200);
    expect(client.json().legalName).toBe(SWEEP_CUSTOMER);

    const deals = await app.inject({
      method: "GET",
      url: "/api/ledger/transactions?limit=200",
      cookies: admin,
    });
    expect(deals.statusCode, deals.body).toBe(200);
    const marked = (deals.json().transactions as Array<Record<string, unknown>>).find(
      (row) => row.transactionRef === ids.transactionRef,
    );
    expect(marked?.structuring, deals.body).toBe(true);
    expect(marked?.strTag, deals.body).toBe("STR");

    const filing = await app.inject({
      method: "GET",
      url: "/api/ledger/report-filings/" + ids.filingId,
      cookies: admin,
    });
    expect(filing.statusCode, filing.body).toBe(200);
    expect(filing.json().reportCode).toBe("STR");
    expect(filing.json().status).toBe("filed");

    for (const route of routes) {
      expect(fillRoute(route, ids), route).not.toMatch(/:/);
    }
  }, 60_000);
});
