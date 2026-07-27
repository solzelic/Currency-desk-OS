/* Acting on a person, not just a desk. Someone leaves, someone's laptop goes
   missing, someone can't get in — support has to be able to shut an account,
   reset a password, and issue the ID they sign in with. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { deskCode, looksLikeCdId } from "../src/auth/cdid.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let adminCookie: Record<string, string> = {};

const ADMIN = "j.masri";
const staffRow = (staffId: string) =>
  handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(1).then((r) => r[0]!);

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = ADMIN;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: ADMIN, password: "yorkville", tenantId: "tnt-yorkfx" } });
  const c = login.cookies.find((x) => x.name === "cdos_session");
  adminCookie = c ? { cdos_session: c.value } : {};
});
afterAll(async () => {
  await app.close(); await handle.close(); vi.restoreAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
});
beforeEach(() => { logged = []; });

describe("the CurrencyDesk ID", () => {
  it("reads as the desk it belongs to", () => {
    expect(deskCode("yorkfx")).toBe("YORK");
    expect(deskCode("24/7 FX")).toBe("FXXX");     // letters only, padded
    expect(looksLikeCdId("CD-YORK-0042")).toBe(true);
    expect(looksLikeCdId("j.masri")).toBe(false);
  });

  it("is issued on demand, and numbers run per desk", async () => {
    const singh = await staffRow("a.singh");
    const first = await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/cd-id`, cookies: adminCookie });
    expect(first.statusCode).toBe(200);
    expect(first.json().cdId).toBe("CD-YORK-0001");
    expect(first.json().previous).toBeNull();

    const costa = await staffRow("m.costa");
    const second = await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/cd-id`, cookies: adminCookie });
    expect(second.json().cdId).toBe("CD-YORK-0002");
  });

  it("signs a person in on its own, without being told which desk", async () => {
    const singh = await staffRow("a.singh");
    expect(singh.cdId).toBe("CD-YORK-0001");
    const res = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "cd-york-0001", password: "yorkville" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ id: "a.singh", tenantId: "tnt-yorkfx" });
  });

  it("reissuing gives a new number, and the old one stops working", async () => {
    const singh = await staffRow("a.singh");
    const res = await app.inject({ method: "POST", url: `/api/admin/staff/${singh.id}/cd-id`, cookies: adminCookie });
    expect(res.json().previous).toBe("CD-YORK-0001");
    expect(res.json().cdId).not.toBe("CD-YORK-0001");

    // an old ID in an email thread must never resolve to somebody else
    const stale = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "CD-YORK-0001", password: "yorkville" } });
    expect(stale.statusCode).toBe(401);
  });
});

describe("acting on a person", () => {
  it("shows support who they are and whether they are signed in anywhere", async () => {
    const costa = await staffRow("m.costa");
    const res = await app.inject({ method: "GET", url: `/api/admin/staff/${costa.id}`, cookies: adminCookie });
    expect(res.statusCode).toBe(200);
    expect(res.json().person).toMatchObject({ staffId: "m.costa", role: "teller", active: true });
    expect(res.json().desk).toMatchObject({ id: "tnt-yorkfx" });
    expect(res.json().sessions).toHaveProperty("live");
  });

  it("blocking someone takes effect now, not when their cookie expires", async () => {
    const costa = await staffRow("m.costa");
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const c = login.cookies.find((x) => x.name === "cdos_session")!;
    const theirs = { cdos_session: c.value };
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: theirs })).statusCode).toBe(200);

    const block = await app.inject({ method: "PATCH", url: `/api/admin/staff/${costa.id}`, cookies: adminCookie, payload: { active: false } });
    expect(block.statusCode).toBe(200);

    // the session they already had is dead, and they cannot get a new one
    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: theirs })).statusCode).toBe(401);
    const retry = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    expect(retry.statusCode).toBe(401);

    const back = await app.inject({ method: "PATCH", url: `/api/admin/staff/${costa.id}`, cookies: adminCookie, payload: { active: true } });
    expect(back.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } })).statusCode).toBe(200);
  });

  it("a password reset issues a temporary one, signs every device out, and forces a change", async () => {
    const haddad = await staffRow("r.haddad");
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const theirs = { cdos_session: login.cookies.find((x) => x.name === "cdos_session")!.value };

    const res = await app.inject({ method: "POST", url: `/api/admin/staff/${haddad.id}/reset-password`, cookies: adminCookie });
    expect(res.statusCode).toBe(200);
    // no address on file for a seeded staff id, so the operator is handed it
    expect(res.json().delivered).toBe("no_address");
    const temp = res.json().tempPassword;
    expect(typeof temp).toBe("string");

    expect((await app.inject({ method: "GET", url: "/api/auth/me", cookies: theirs })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "r.haddad", password: "yorkville", tenantId: "tnt-yorkfx" } })).statusCode).toBe(401);

    const withTemp = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "r.haddad", password: temp, tenantId: "tnt-yorkfx" } });
    expect(withTemp.statusCode).toBe(200);
    expect(withTemp.json().user.mustChangePassword).toBe(true);
  });

  it("emails the temporary password when there is somewhere to send it, and never returns it", async () => {
    await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Reset FX", ownerName: "Reese Kim", email: "reese@resetfx.ca", password: "a-strong-pass", slug: "resetfx" } });
    const code = [...logged].reverse().find((l) => l.includes("[email simulated]"))!.match(/(\d{6}) is your/)![1]!;
    await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "reese@resetfx.ca", code } });

    const owner = await staffRow("reese@resetfx.ca");
    const res = await app.inject({ method: "POST", url: `/api/admin/staff/${owner.id}/reset-password`, cookies: adminCookie });
    expect(res.json().delivered).toBe("simulated");
    expect(res.json().tempPassword).toBeUndefined();
    expect(logged.some((l) => l.includes("password was reset"))).toBe(true);
  });

  it("every one of these is on the record", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("admin.person_blocked");
    expect(actions).toContain("admin.person_unblocked");
    expect(actions).toContain("admin.password_reset");
    expect(actions).toContain("admin.cd_id_issued");
    expect(actions).toContain("admin.cd_id_reissued");
  });

  it("none of it is reachable without being a platform admin", async () => {
    const costa = await staffRow("m.costa");
    expect((await app.inject({ method: "GET", url: `/api/admin/staff/${costa.id}` })).statusCode).toBe(401);
    const teller = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const theirs: Record<string, string> = {};
    const c = teller.cookies.find((x) => x.name === "cdos_session");
    if (c) theirs.cdos_session = c.value;
    expect((await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/reset-password`, cookies: theirs })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/admin/staff/${costa.id}/cd-id`, cookies: theirs })).statusCode).toBe(403);
  });
});
