/* A session with must_change_password set is not a desk session.
   The sign-in screen used to be the only thing that read the flag, so
   GET /api/staff (and every other protected route) still answered 200.
   Issue #419. The change itself, sign-out, and the sign-in doors stay
   open. After a successful change the same cookie is a normal session. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  if (!c) throw new Error("no session cookie");
  return { cdos_session: c.value };
};

const login = async (staffId: string, password = DEMO.password) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password } });

const REFUSAL = {
  error: "password_change_required",
  detail: "Change your password to keep going.",
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

describe("must-change-password is enforced on the server", () => {
  it("lets an ordinary owner session read the roster", async () => {
    const owner = cookieOf(await login("j.masri"));
    const res = await app.inject({ method: "GET", url: "/api/staff", cookies: owner });
    expect(res.statusCode).toBe(200);
  });

  it("refuses protected routes while the flag is set, including a query-string bypass", async () => {
    const owner = cookieOf(await login("j.masri"));
    await handle.db
      .update(schema.staffUsers)
      .set({ mustChangePassword: true })
      .where(eq(schema.staffUsers.staffId, "j.masri"));

    for (const url of ["/api/staff", "/api/staff?x=1", "/api/tenant", "/api/auth/me", "/api/quotes", "/api/rates"]) {
      const res = await app.inject({ method: "GET", url, cookies: owner });
      expect(res.statusCode, url).toBe(403);
      expect(res.json(), url).toEqual(REFUSAL);
    }

    const switched = await app.inject({
      method: "POST",
      url: "/api/auth/switch",
      cookies: owner,
      payload: { staffId: "m.costa", pin: "0000" },
    });
    expect(switched.statusCode).toBe(403);
    expect(switched.json()).toEqual(REFUSAL);
    expect(switched.cookies.find((c) => c.name === "cdos_session")).toBeUndefined();

    const odd = await app.inject({ method: "GET", url: "/api/public/../staff", cookies: owner });
    expect(odd.statusCode).not.toBe(200);
    expect(odd.json().error).not.toBeUndefined();
  });

  it("still answers routes that do not use this session", async () => {
    const owner = cookieOf(await login("j.masri"));
    const health = await app.inject({ method: "GET", url: "/api/health", cookies: owner });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    const market = await app.inject({ method: "GET", url: "/api/rates/market", cookies: owner });
    expect(market.statusCode).toBe(200);
    expect(market.json().error).not.toBe("password_change_required");

    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      cookies: owner,
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().user.mustChangePassword).toBe(true);

    const stranger = await app.inject({ method: "GET", url: "/api/staff" });
    expect(stranger.statusCode).toBe(401);
  });

  it("leaves a session that does not have the flag alone", async () => {
    const teller = cookieOf(await login("m.costa"));
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: teller });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(false);
  });

  it("keeps the gate up when the current password is wrong, and sign-out still works", async () => {
    const owner = cookieOf(await login("j.masri"));
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      cookies: owner,
      payload: { currentPassword: "not-the-password", newPassword: "replaced-pass-1" },
    });
    expect(wrong.statusCode).toBe(401);
    const still = await app.inject({ method: "GET", url: "/api/staff", cookies: owner });
    expect(still.statusCode).toBe(403);
    expect(still.json()).toEqual(REFUSAL);

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", cookies: owner });
    expect(out.statusCode).toBe(200);
    const dead = await app.inject({ method: "GET", url: "/api/tenant", cookies: owner });
    expect(dead.statusCode).toBe(401);
  });

  it("restores access on the session that changed the password and kills the other one", async () => {
    const first = cookieOf(await login("j.masri"));
    const second = cookieOf(await login("j.masri"));
    expect((await app.inject({ method: "GET", url: "/api/staff", cookies: second })).statusCode).toBe(403);

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      cookies: first,
      payload: { currentPassword: DEMO.password, newPassword: "replaced-pass-1" },
    });
    expect(change.statusCode).toBe(200);

    const roster = await app.inject({ method: "GET", url: "/api/staff", cookies: first });
    expect(roster.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: first });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(false);

    const other = await app.inject({ method: "GET", url: "/api/staff", cookies: second });
    expect(other.statusCode).toBe(401);

    const fresh = await login("j.masri", "replaced-pass-1");
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.mustChangePassword).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/tenant", cookies: cookieOf(fresh) })).statusCode).toBe(200);
  });
});
