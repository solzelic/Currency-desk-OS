/* Admin control actions — overview, block/suspend (blocks login), change plan,
   create a desk, delete a desk. Platform-admin gated. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let admin = "";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  const li = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: "tnt-yorkfx" } });
  admin = `cdos_session=${li.cookies.find((c) => c.name === "cdos_session")!.value}`;
  // a desk to manage, via the real signup flow
  await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Zephyr FX", ownerName: "Zoe", email: "zoe@zephyr.ca", password: "a-strong-pass", slug: "zephyr", onboarding: { plan: "pro" } } });
  await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "zoe@zephyr.ca", code: codeFromLog() } });
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => { logged = []; });
function codeFromLog(): string { const l = [...logged].reverse().find((x) => x.includes("[email simulated]")); const m = l?.match(/(\d{6}) is your/); if (!m) throw new Error("no code"); return m[1]!; }
const H = { headers: { cookie: "" } };
const as = () => ({ headers: { cookie: admin } });

describe("admin control actions", () => {
  it("overview reports totals", async () => {
    const o = await app.inject({ method: "GET", url: "/api/admin/overview", ...as() });
    expect(o.statusCode).toBe(200);
    expect(o.json().totals.desks).toBeGreaterThanOrEqual(2); // York + Zephyr
    expect(o.json().byStatus).toBeTruthy();
  });

  it("suspending a desk blocks its sign-in; unsuspending restores it", async () => {
    const sus = await app.inject({ method: "PATCH", url: "/api/admin/tenants/tnt-zephyr", ...as(), payload: { suspended: true } });
    expect(sus.statusCode).toBe(200);
    const blocked = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "zoe@zephyr.ca", password: "a-strong-pass" } });
    expect(blocked.statusCode).toBe(403);

    await app.inject({ method: "PATCH", url: "/api/admin/tenants/tnt-zephyr", ...as(), payload: { suspended: false } });
    const restored = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "zoe@zephyr.ca", password: "a-strong-pass" } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().needsCode).toBe(true);
  });

  it("changes a desk's plan", async () => {
    await app.inject({ method: "PATCH", url: "/api/admin/tenants/tnt-zephyr", ...as(), payload: { plan: "premium" } });
    const t = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-zephyr")))[0]!;
    expect(t.plan).toBe("premium");
  });

  it("creates a desk by hand, then deletes it (cascade)", async () => {
    const create = await app.inject({ method: "POST", url: "/api/admin/tenants", ...as(), payload: { businessName: "Manual Co", ownerName: "Max", ownerEmail: "max@manual.co", slug: "manualco", plan: "basic", password: "a-strong-pass" } });
    expect(create.statusCode).toBe(201);
    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-manualco"))).length).toBe(1);
    expect((await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "max@manual.co"))).length).toBe(1);

    // deletion is gated: a desk must be suspended first (retention safety)
    const tooSoon = await app.inject({ method: "DELETE", url: "/api/admin/tenants/tnt-manualco", ...as() });
    expect(tooSoon.statusCode).toBe(409);
    await app.inject({ method: "PATCH", url: "/api/admin/tenants/tnt-manualco", ...as(), payload: { suspended: true } });
    const del = await app.inject({ method: "DELETE", url: "/api/admin/tenants/tnt-manualco", ...as() });
    expect(del.statusCode).toBe(200);
    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-manualco"))).length).toBe(0);
    expect((await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "max@manual.co"))).length).toBe(0);
  });

  it("blocks a non-admin from control actions", async () => {
    const li = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    const teller = `cdos_session=${li.cookies.find((c) => c.name === "cdos_session")!.value}`;
    const patch = await app.inject({ method: "PATCH", url: "/api/admin/tenants/tnt-zephyr", headers: { cookie: teller }, payload: { suspended: true } });
    expect(patch.statusCode).toBe(403);
  });
});
