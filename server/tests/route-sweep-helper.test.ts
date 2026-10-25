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
let seeded: SweepIds | undefined;
let priorPglite: string | undefined;
let priorSeed: string | undefined;
let capturedEnv = false;

async function session(staffId: string, tenantId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId, password: DEMO.password, tenantId },
  });
  expect(login.statusCode, login.body).toBe(200);
  return { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
}

beforeAll(async () => {
  priorPglite = process.env.PGLITE_MEMORY;
  priorSeed = process.env.SEED_PASSWORD;
  capturedEnv = true;
  expect(ledgerUrl, "TEST_DATABASE_URL").toBeTruthy();
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.LEDGER_DATABASE_URL = ledgerUrl;
  handle = await createDb();
  await seed(handle.db);
  pool = await provisionPostgres(ledgerUrl!);
  app = await buildApp(handle.db);
}, 60_000);

afterAll(async () => {
  /* The sealed STR filing, the 2 deals and their audit row stay in the
     disposable test DB by design, because the append-only and sealed
     guards block deletes, and option A (a fresh schema per run) is
     tracked in #371
     https://github.com/solzelic/Currency-desk-OS/issues/371 */
  try {
    if (pool && seeded) {
      await pool.query("DELETE FROM quote_events WHERE quote_id = $1", [seeded.quoteId]);
      await pool.query("DELETE FROM quote_overrides WHERE quote_id = $1", [seeded.quoteId]);
      await pool.query("DELETE FROM quotes WHERE quote_id = $1", [seeded.quoteId]);
      await pool.query("DELETE FROM desk_clients WHERE client_id = $1", [seeded.clientId]);
      await pool.query("DELETE FROM ledger_customers WHERE customer_id = $1", [seeded.customerId]);
      const left = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM desk_clients WHERE client_id = $1) AS clients,
           (SELECT count(*)::int FROM quotes WHERE quote_id = $2) AS quotes`,
        [seeded.clientId, seeded.quoteId],
      );
      expect(left.rows[0]?.clients, "client removed").toBe(0);
      expect(left.rows[0]?.quotes, "quote removed").toBe(0);
    }
  } finally {
    try {
      await app?.close();
      await handle?.close();
      await pool?.end();
    } finally {
      delete process.env.LEDGER_DATABASE_URL;
      if (capturedEnv) {
        if (priorPglite === undefined) delete process.env.PGLITE_MEMORY;
        else process.env.PGLITE_MEMORY = priorPglite;
        if (priorSeed === undefined) delete process.env.SEED_PASSWORD;
        else process.env.SEED_PASSWORD = priorSeed;
      }
    }
  }
  expect(process.env.PGLITE_MEMORY, "PGLITE_MEMORY").toBe(priorPglite);
  expect(process.env.SEED_PASSWORD, "SEED_PASSWORD").toBe(priorSeed);
});

describe("route sweep helper", () => {
  it("lists GET routes, seeds the fixture, and fills every param", async () => {
    const routes = listGetRoutes(app);
    expect(routes, "listed " + routes.length).toEqual(
      expect.arrayContaining(["/api/tenant/state", "/api/clients/:clientId"]),
    );
    expect(routes.length, "GET routes").toBeGreaterThanOrEqual(MIN_GET_ROUTES);

    const ids: SweepIds = await seedSweepFixture(app, pool, handle.db);
    seeded = ids;
    const tellerId = ids.tenantId + ":m.costa";
    expect(ids.staffId, "teller id").toBe(tellerId);
    const admin = await session("j.masri", ids.tenantId);
    const client = await app.inject({ method: "GET", url: "/api/clients/" + ids.clientId, cookies: admin });
    expect(client.statusCode, client.body).toBe(200);
    expect(client.json().legalName).toBe(SWEEP_CUSTOMER);
    expect(client.json().createdBy, "client creator").toBe(tellerId);
    const quoteRow = await pool.query("SELECT created_by FROM quotes WHERE quote_id = $1", [ids.quoteId]);
    expect(quoteRow.rows[0]?.created_by, "quote creator").toBe(tellerId);

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
