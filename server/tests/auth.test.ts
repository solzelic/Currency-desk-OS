/* Auth + tenancy integration tests — full HTTP app against embedded PGlite. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const sessionCookie = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("auth", () => {
  it("rejects a wrong password", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "a.singh", password: "wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown staff id with the same error (no enumeration)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "not.a.user", password: "wrong" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_credentials" });
  });

  it("logs in with valid credentials and sets an httpOnly session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "a.singh", password: DEMO.password } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({
      id: "a.singh",
      role: "supervisor",
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      authorizedBranchIds: [DEMO.branchId],
    });
    const cookie = res.cookies.find((c) => c.name === "cdos_session");
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
  });

  it("resolves the session on /me and revokes it on logout", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: DEMO.password } });
    const cookies = sessionCookie(login);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: "j.masri", role: "administrator" });

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies });
    expect(out.statusCode).toBe(200);

    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(meAfter.statusCode).toBe(401);
  });

  it("returns 401 on /me with no session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
  });

  it("scopes login to the tenant (same staff id in another tenant does not match)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "a.singh", password: DEMO.password, tenantId: "tnt-other" },
    });
    expect(res.statusCode).toBe(401);
  });
});
