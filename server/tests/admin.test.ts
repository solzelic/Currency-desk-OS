/* Platform Admin Console — cross-tenant back office, gated to
   PLATFORM_ADMIN_EMAILS. A normal owner/teller can't reach it. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = "j.masri, super@nope.ca"; // seeded York admin is the platform admin
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => { logged = []; });

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/);
  if (!m) throw new Error("no code in log");
  return m[1]!;
};
const cookieOf = (res: { cookies: { name: string; value: string }[] }): string => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? `cdos_session=${c.value}` : "";
};
async function login(staffId: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId, password: "yorkville", tenantId: "tnt-yorkfx" } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}

describe("platform admin console", () => {
  it("is gated: 401 without a session, 403 for a non-admin", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/admin/tenants" });
    expect(anon.statusCode).toBe(401);
    const teller = await login("m.costa");
    const forbidden = await app.inject({ method: "GET", url: "/api/admin/tenants", headers: { cookie: teller } });
    expect(forbidden.statusCode).toBe(403);
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: teller } });
    expect(me.json().isAdmin).toBe(false);
  });

  it("lists every desk + its owner for a platform admin", async () => {
    const admin = await login("j.masri");
    expect((await app.inject({ method: "GET", url: "/api/admin/me", headers: { cookie: admin } })).json().isAdmin).toBe(true);

    // sign up a brand-new desk so there's more than the seed
    await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Aspen FX", ownerName: "Sam Lee", email: "sam@aspenadmin.ca", password: "a-strong-pass", slug: "aspenadmin", onboarding: { country: "Canada", regulator: "FINTRAC", plan: "pro" } } });
    await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@aspenadmin.ca", code: codeFromLog() } });

    const list = await app.inject({ method: "GET", url: "/api/admin/tenants", headers: { cookie: admin } });
    expect(list.statusCode).toBe(200);
    const tenants = list.json().tenants as any[];
    const york = tenants.find((t) => t.id === "tnt-yorkfx");
    const aspen = tenants.find((t) => t.id === "tnt-aspenadmin");
    expect(york).toBeTruthy();
    expect(aspen).toMatchObject({ name: "Aspen FX", slug: "aspenadmin", plan: "pro", country: "Canada", regulator: "FINTRAC" });
    expect(aspen.owner).toMatchObject({ staffId: "sam@aspenadmin.ca", name: "Sam Lee" });
  });

  it("returns a desk's detail + its audit trail", async () => {
    const admin = await login("j.masri");
    const detail = await app.inject({ method: "GET", url: "/api/admin/tenants/tnt-aspenadmin", headers: { cookie: admin } });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.tenant).toMatchObject({ id: "tnt-aspenadmin", name: "Aspen FX" });
    expect(body.staff.some((s: any) => s.staffId === "sam@aspenadmin.ca" && s.role === "administrator")).toBe(true);
    expect(body.audit.some((e: any) => e.action === "tenant.created")).toBe(true);

    const audit = await app.inject({ method: "GET", url: "/api/admin/audit?limit=50", headers: { cookie: admin } });
    expect(audit.json().events.some((e: any) => e.action === "tenant.created" && e.tenantName)).toBe(true);
  });
});
