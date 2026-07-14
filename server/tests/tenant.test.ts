/* Tenant plan (purchased tier) — task #9. The tier lives on the tenant:
   login/me expose it, only an administrator changes it (audited), and
   API plan-gates refuse what the tier doesn't include. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};
const login = async (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: DEMO.password } });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  // register the ledger routes without a real Postgres: the plan gate fires
  // before the service ever touches the pool, which is what we test here
  process.env.LEDGER_DATABASE_URL = "postgres://plan-gate-test-only";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  delete process.env.LEDGER_DATABASE_URL;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("tenant plan", () => {
  it("defaults to premium and is exposed at login and /me", async () => {
    const res = await login("m.costa");
    expect(res.statusCode).toBe(200);
    expect(res.json().user.plan).toBe("premium");
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: cookieOf(res) });
    expect(me.json().user.plan).toBe("premium");
    const t = await app.inject({ method: "GET", url: "/api/tenant", cookies: cookieOf(res) });
    expect(t.json().tenant).toMatchObject({ id: DEMO.tenantId, plan: "premium" });
  });

  it("only an administrator can change the plan", async () => {
    const mgr = await login("r.haddad");
    const denied = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(mgr), payload: { plan: "basic" } });
    expect(denied.statusCode).toBe(403);

    const admin = await login("j.masri");
    const ok = await app.inject({ method: "PATCH", url: "/api/tenant", cookies: cookieOf(admin), payload: { plan: "basic" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().tenant.plan).toBe("basic");
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("tenant.plan_changed");
  });

  it("a basic tenant is refused ledger posting but keeps the rate board", async () => {
    const admin = await login("j.masri");
    const cookies = cookieOf(admin);

    const post = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: { idempotencyKey: "t9-1", customerId: "c1", from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "0", purpose: "", sourceOfFunds: "" },
    });
    // plan gate fires before workspace scoping — basic is refused outright
    expect(post.statusCode).toBe(403);
    expect(post.json().code).toBe("PLAN_NOT_ENTITLED");

    // the rate board stays available on basic
    const board = await app.inject({ method: "GET", url: "/api/rates" });
    expect(board.statusCode).toBe(200);
    const publish = await app.inject({
      method: "POST",
      url: "/api/rates/publish",
      cookies,
      payload: { buyMargin: 0.015, sellMargin: 0.015, rows: { USD: { mid: 1.36 } } },
    });
    expect([200, 201]).toContain(publish.statusCode);
  });

  it("upgrading back to pro lifts the ledger gate", async () => {
    const admin = await login("j.masri");
    const cookies = cookieOf(admin);
    await app.inject({ method: "PATCH", url: "/api/tenant", cookies, payload: { plan: "pro" } });
    const post = await app.inject({
      method: "POST",
      url: "/api/ledger/exchanges",
      cookies,
      payload: { idempotencyKey: "t9-2", customerId: "c1", from: "CAD", to: "USD", inputAmount: "100.00", feeCad: "0", purpose: "", sourceOfFunds: "" },
    });
    // past the plan gate now — the request proceeds until it hits the dummy
    // ledger pool, so anything but PLAN_NOT_ENTITLED proves the gate lifted
    expect(post.json().code).not.toBe("PLAN_NOT_ENTITLED");
  });
});
