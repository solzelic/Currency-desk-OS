/* A deactivated person is not a way in and not a name.
   The switch list omits them. The ID step answers exactly as it does
   for an unknown id: same status, same body, same timing class, no
   name and no role. Login does too. A switch with the right PIN is
   refused and writes no session. Employees still lists them. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

let handle: DbHandle;
let app: FastifyInstance;
let mgr: Record<string, string>;

const cookieOf = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

const sessionsFor = async (staffId: string) =>
  handle.db.select().from(schema.sessions).where(eq(schema.sessions.userId, `${DEMO.tenantId}:${staffId}`));

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  handle = await createDb();
  await seed(handle.db);
  await handle.db
    .update(schema.staffUsers)
    .set({ active: false, pinHash: await hashPassword("1739"), pinMustChange: false })
    .where(eq(schema.staffUsers.staffId, "j.masri"));
  app = await buildApp(handle.db);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "r.haddad", password: DEMO.password },
  });
  expect(login.statusCode).toBe(200);
  mgr = cookieOf(login);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("inactive staff stay off the switch list and the sign-in", () => {
  it("leaves inactive staff out of the switch list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/colleagues", cookies: mgr });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().staff as { staffId: string }[]).map((s) => s.staffId);
    expect(ids).not.toContain("j.masri");
    expect(JSON.stringify(res.json())).not.toMatch(/Masri|passwordHash|pinHash/);
  });

  it("answers an inactive id the same as an unknown id", async () => {
    const ask = (staffId: string) =>
      app.inject({ method: "POST", url: "/api/auth/id", payload: { staffId } });
    const inactive = await ask("j.masri");
    const unknown = await ask("no.such.person");
    expect(inactive.statusCode).toBe(unknown.statusCode);
    expect(inactive.json()).toEqual(unknown.json());
    expect(inactive.body).toBe(unknown.body);
    expect(inactive.json()).toEqual({ error: "not_found" });
    expect(inactive.body).not.toMatch(/Masri|Owner|administrator/);

    const median = async (staffId: string) => {
      const times: number[] = [];
      let status = 0;
      let body: unknown;
      for (let n = 0; n < 5; n += 1) {
        const started = performance.now();
        const res = await ask(staffId);
        times.push(performance.now() - started);
        status = res.statusCode;
        body = res.json();
      }
      times.sort((a, b) => a - b);
      return { status, body, median: times[2]! };
    };
    const gone = await median("j.masri");
    const stranger = await median(`nobody-${Date.now()}`);
    expect(gone.status).toBe(stranger.status);
    expect(gone.body).toEqual(stranger.body);
    const gap = Math.abs(gone.median - stranger.median);
    expect(gap, `medians inactive=${gone.median.toFixed(1)}ms unknown=${stranger.median.toFixed(1)}ms`).toBeLessThan(
      Math.max(gone.median, stranger.median) * 0.75 + 30,
    );

    const live = await ask("r.haddad");
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ name: "R. Haddad", role: "branch_manager" });
  });

  it("refuses login and a correct-PIN switch, and writes no session", async () => {
    expect(await sessionsFor("j.masri")).toHaveLength(0);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    expect(login.statusCode).not.toBe(200);
    expect(cookieOf(login)).toEqual({});
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      payload: { staffId: "j.masri", password: DEMO.password },
    });
    expect(start.statusCode).not.toBe(200);
    expect(await sessionsFor("j.masri")).toHaveLength(0);

    const sw = await app.inject({
      method: "POST",
      url: "/api/auth/switch",
      cookies: mgr,
      payload: { staffId: "j.masri", pin: "1739" },
    });
    expect(sw.statusCode).not.toBe(200);
    expect(await sessionsFor("j.masri")).toHaveLength(0);
    const still = await app.inject({ method: "GET", url: "/api/auth/me", cookies: mgr });
    expect(still.json().user.id).toBe("r.haddad");
  });

  it("a wrong password on an inactive id matches an unknown id", async () => {
    const wrong = "not-the-password";
    const inactive = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "203.0.113.71",
      payload: { staffId: "j.masri", password: wrong },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "203.0.113.72",
      payload: { staffId: "no.such.person", password: wrong },
    });
    expect(inactive.statusCode).toBe(unknown.statusCode);
    expect(inactive.json()).toEqual(unknown.json());
    expect(inactive.body).not.toMatch(/Masri|Owner|inactive|name|role/);
    expect(await sessionsFor("j.masri")).toHaveLength(0);
  });

  it("counts active employees the same as the switch list", async () => {
    const roster = await app.inject({ method: "GET", url: "/api/staff", cookies: mgr });
    expect(roster.statusCode).toBe(200);
    const staff = roster.json().staff as { staffId: string; active: boolean; name: string }[];
    const inactive = staff.find((s) => s.staffId === "j.masri");
    expect(inactive).toMatchObject({ active: false, name: "J. Masri" });
    const colleagues = await app.inject({ method: "GET", url: "/api/auth/colleagues", cookies: mgr });
    const listed = colleagues.json().staff as { staffId: string }[];
    expect(listed).toHaveLength(staff.filter((s) => s.active).length);
    expect(listed.map((s) => s.staffId).sort()).toEqual(staff.filter((s) => s.active).map((s) => s.staffId).sort());
  });
});
