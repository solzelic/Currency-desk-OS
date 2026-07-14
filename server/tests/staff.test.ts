/* Staff administration — per-employee credentials, full HTTP app against PGlite.
   Covers the task-#8 contract: managers create employees and reset passwords
   from the OS, each employee signs in with their own credentials, everything
   is audited, and no environment variable overwrites passwords anymore. */
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
  return c ? { cdos_session: c.value } : {};
};

const login = async (staffId: string, password: string) =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password } });

const auditActions = async () =>
  (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);

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

describe("staff roster access control", () => {
  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/staff" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses non-managers", async () => {
    const teller = await login("m.costa", DEMO.password);
    expect(teller.statusCode).toBe(200);
    const res = await app.inject({ method: "GET", url: "/api/staff", cookies: cookieOf(teller) });
    expect(res.statusCode).toBe(403);
  });

  it("lists the roster for a manager, without password material", async () => {
    const mgr = await login("r.haddad", DEMO.password);
    const res = await app.inject({ method: "GET", url: "/api/staff", cookies: cookieOf(mgr) });
    expect(res.statusCode).toBe(200);
    const { staff } = res.json();
    expect(staff.length).toBeGreaterThanOrEqual(5);
    for (const s of staff) {
      expect(s).not.toHaveProperty("passwordHash");
      expect(s).not.toHaveProperty("password_hash");
    }
  });
});

describe("employee lifecycle", () => {
  it("manager creates an employee; they sign in with their own temp password", async () => {
    const mgr = await login("r.haddad", DEMO.password);
    const create = await app.inject({
      method: "POST",
      url: "/api/staff",
      cookies: cookieOf(mgr),
      payload: { staffId: "n.demir", name: "N. Demir", role: "teller", password: "temp-pass-1" },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().staff).toMatchObject({ staffId: "n.demir", role: "teller", mustChangePassword: true, active: true });

    const bad = await login("n.demir", "wrong-password");
    expect(bad.statusCode).toBe(401);
    const ok = await login("n.demir", "temp-pass-1");
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.mustChangePassword).toBe(true);
    expect(await auditActions()).toContain("staff.created");
  });

  it("temp password is one-shot: change-password clears the flag and rotates the credential", async () => {
    const session = await login("n.demir", "temp-pass-1");
    const cookies = cookieOf(session);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      cookies,
      payload: { currentPassword: "not-it", newPassword: "my-own-secret-9" },
    });
    expect(wrong.statusCode).toBe(401);

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      cookies,
      payload: { currentPassword: "temp-pass-1", newPassword: "my-own-secret-9" },
    });
    expect(change.statusCode).toBe(200);

    // own session survives, the old password is dead, flag is cleared
    const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(false);
    expect((await login("n.demir", "temp-pass-1")).statusCode).toBe(401);
    expect((await login("n.demir", "my-own-secret-9")).statusCode).toBe(200);
    expect(await auditActions()).toContain("auth.password_changed");
  });

  it("duplicate staff ids are refused", async () => {
    const mgr = await login("r.haddad", DEMO.password);
    const res = await app.inject({
      method: "POST",
      url: "/api/staff",
      cookies: cookieOf(mgr),
      payload: { staffId: "n.demir", name: "Other N", role: "teller", password: "whatever-8" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("a branch manager cannot mint accounts at or above their own rank", async () => {
    const mgr = await login("r.haddad", DEMO.password);
    for (const role of ["branch_manager", "administrator"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/staff",
        cookies: cookieOf(mgr),
        payload: { staffId: "x.escalate", name: "X", role, password: "whatever-8" },
      });
      expect(res.statusCode).toBe(403);
    }
    // the administrator can create a manager
    const admin = await login("j.masri", DEMO.password);
    const res = await app.inject({
      method: "POST",
      url: "/api/staff",
      cookies: cookieOf(admin),
      payload: { staffId: "k.mgr", name: "K. Manager", role: "branch_manager", password: "whatever-8" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("password reset by a manager kills existing sessions and issues a temp credential", async () => {
    const target = await login("n.demir", "my-own-secret-9");
    const targetCookies = cookieOf(target);

    const mgr = await login("r.haddad", DEMO.password);
    const reset = await app.inject({
      method: "POST",
      url: "/api/staff/n.demir/password",
      cookies: cookieOf(mgr),
      payload: { password: "issued-temp-22" },
    });
    expect(reset.statusCode).toBe(200);

    // old session revoked, old password dead, temp password flagged
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: targetCookies })).statusCode).toBe(401);
    expect((await login("n.demir", "my-own-secret-9")).statusCode).toBe(401);
    const again = await login("n.demir", "issued-temp-22");
    expect(again.statusCode).toBe(200);
    expect(again.json().user.mustChangePassword).toBe(true);
    expect(await auditActions()).toContain("staff.password_reset");
  });

  it("managers reset their own password only via change-password", async () => {
    const mgr = await login("r.haddad", DEMO.password);
    const res = await app.inject({
      method: "POST",
      url: "/api/staff/r.haddad/password",
      cookies: cookieOf(mgr),
      payload: { password: "sneaky-reset-1" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("deactivation locks the account out immediately; reactivation restores it", async () => {
    const target = await login("n.demir", "issued-temp-22");
    const targetCookies = cookieOf(target);
    const mgr = await login("r.haddad", DEMO.password);

    const off = await app.inject({ method: "PATCH", url: "/api/staff/n.demir", cookies: cookieOf(mgr), payload: { active: false } });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: targetCookies })).statusCode).toBe(401);
    expect((await login("n.demir", "issued-temp-22")).statusCode).toBe(401);
    expect(await auditActions()).toContain("staff.deactivated");

    const on = await app.inject({ method: "PATCH", url: "/api/staff/n.demir", cookies: cookieOf(mgr), payload: { active: true } });
    expect(on.statusCode).toBe(200);
    expect((await login("n.demir", "issued-temp-22")).statusCode).toBe(200);
  });

  it("nobody can deactivate or demote their own account", async () => {
    const admin = await login("j.masri", DEMO.password);
    const off = await app.inject({ method: "PATCH", url: "/api/staff/j.masri", cookies: cookieOf(admin), payload: { active: false } });
    expect(off.statusCode).toBe(403);
    const demote = await app.inject({ method: "PATCH", url: "/api/staff/j.masri", cookies: cookieOf(admin), payload: { role: "teller" } });
    expect(demote.statusCode).toBe(403);
  });

  it("re-seeding never overwrites an existing password (SEED_PASSWORD scheme is gone)", async () => {
    const before = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "n.demir"));
    process.env.SEED_PASSWORD = "hostile-env-value";
    await seed(handle.db);
    delete process.env.SEED_PASSWORD;
    const after = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "n.demir"));
    expect(after[0]!.passwordHash).toBe(before[0]!.passwordHash);
    // and the seeded account still uses its original credential
    expect((await login("n.demir", "issued-temp-22")).statusCode).toBe(200);
  });
});
