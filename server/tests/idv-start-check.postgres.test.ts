/* 12 parallel starts on Postgres. The cap is 5. No live keys. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { DEMO, seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const ENV = { PERSONA_API_KEY: "fixture-api-key" };
const ROUTE = "/api/idv/start-check";
const SHOP = "le-idv-cap";

postgres("start-check cap on postgres", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls += 1;
    const id = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({ data: { id: `inq_cap_${id}` } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    delete process.env.PGLITE_MEMORY;
    handle = await createDb();
    await seed(handle.db);
    const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "j.masri")).limit(1);
    await handle.db.insert(schema.tenants).values({ id: "tnt-idv-cap", name: "Cap Shop" }).onConflictDoNothing();
    await handle.db.insert(schema.legalEntities).values({ id: SHOP, tenantId: "tnt-idv-cap", name: "Cap Shop", jurisdiction: "FINTRAC" }).onConflictDoNothing();
    await handle.db.insert(schema.branches).values({ id: "br-idv-cap", tenantId: "tnt-idv-cap", legalEntityId: SHOP, name: "Cap counter" }).onConflictDoNothing();
    await handle.db.insert(schema.staffUsers).values({
      id: "tnt-idv-cap:c.owner", tenantId: "tnt-idv-cap", legalEntityId: SHOP, branchId: "br-idv-cap",
      staffId: "c.owner", name: "Cap Owner", role: "administrator", authorizedBranchIds: ["br-idv-cap"], passwordHash: owner[0]!.passwordHash,
    }).onConflictDoNothing();
    await handle.db.execute(sql`
      INSERT INTO idv_shop_config (shop_id, provider, api_key_ref, template_id, checks_enabled)
      VALUES (${SHOP}, 'persona', 'PERSONA_API_KEY', 'itmpl_fixture', true)
      ON CONFLICT (shop_id) DO UPDATE
        SET checks_enabled = true, provider = 'persona', api_key_ref = 'PERSONA_API_KEY', template_id = 'itmpl_fixture'
    `);
    app = await buildApp(handle.db, {}, undefined, { env: ENV, fetch: fetchStub, sleep: async () => {} });
  });

  afterAll(async () => {
    await handle.db.execute(sql`DELETE FROM idv_events WHERE shop_id = ${SHOP}`);
    await handle.db.execute(sql`DELETE FROM idv_inquiries WHERE shop_id = ${SHOP}`);
    await handle.db.execute(sql`DELETE FROM idv_shop_config WHERE shop_id = ${SHOP}`);
    await app.close();
    await handle.close();
    delete process.env.DATABASE_URL;
    process.env.PGLITE_MEMORY = "1";
  });

  it("keeps 12 parallel starts to 5 open checks and 5 provider calls", async () => {
    const login = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { staffId: "c.owner", password: DEMO.password, tenantId: "tnt-idv-cap" },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookies = { cdos_session: login.cookies.find((item) => item.name === "cdos_session")!.value };
    const results = await Promise.all(Array.from({ length: 12 }, () => app.inject({ method: "POST", url: ROUTE, cookies, payload: {} })));
    const open = await handle.db.execute(sql`
      SELECT count(*)::int AS n FROM idv_inquiries
       WHERE shop_id = ${SHOP} AND status IN ('starting', 'in progress', 'needs review')
    `);
    const n = Number((open.rows[0] as { n: number }).n);
    const ok = results.filter((res) => res.statusCode === 200).length;
    expect({ open: n, calls, ok }).toEqual({ open: 5, calls: 5, ok: 5 });
  });
});
