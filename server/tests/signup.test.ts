/* Signup + email-OTP — full HTTP app against embedded PGlite.
   The code is read from the server log (simulated email), so no provider. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];

// capture the simulated-email log line so we can read the code
beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => { logged = []; });

const codeFromLog = (): string => {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/is your CurrencyDesk verification code/) ? line.match(/(\d{6}) is your/) : line?.match(/code is (\d{6})/);
  if (!m) throw new Error("no code in log: " + JSON.stringify(logged));
  return m[1]!;
};
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
  const c = res.cookies.find((x) => x.name === "cdos_session");
  return c ? { cdos_session: c.value } : {};
};

describe("signup", () => {
  it("creates NO tenant until the emailed code is verified", async () => {
    const before = (await handle.db.select().from(schema.tenants)).length;
    const res = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Maple FX", ownerName: "Dana Kim", email: "dana@maplefx.ca", password: "a-strong-pass", slug: "maplefx" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, email: "dana@maplefx.ca" });
    // held in pending, no tenant yet
    expect((await handle.db.select().from(schema.tenants)).length).toBe(before);
    expect((await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, "dana@maplefx.ca"))).length).toBe(1);
  });

  it("wrong code is rejected; the right one creates the tenant + owner and signs in", async () => {
    const wrong = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "dana@maplefx.ca", code: "000000" } });
    expect(wrong.statusCode).toBe(401);

    // re-issue a known code and read it from the log
    await app.inject({ method: "POST", url: "/api/signup/resend", payload: { email: "dana@maplefx.ca" } });
    const code = codeFromLog();
    const ok = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "dana@maplefx.ca", code } });
    expect(ok.statusCode).toBe(201);
    const body = ok.json();
    expect(body.tenant).toMatchObject({ slug: "maplefx", name: "Maple FX" });
    expect(body.tenant.plan).toBe(body.user.plan); // consistent entitlement
    expect(body.user).toMatchObject({ id: "dana@maplefx.ca", role: "administrator", tenantId: "tnt-maplefx" });
    expect(cookieOf(ok).cdos_session).toBeTruthy();

    // the tenant, owner, and audit exist; the pending row is gone
    expect((await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-maplefx"))).length).toBe(1);
    const owner = await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, "dana@maplefx.ca"));
    expect(owner[0]).toMatchObject({ role: "administrator", tenantId: "tnt-maplefx" });
    expect((await handle.db.select().from(schema.pendingSignups).where(eq(schema.pendingSignups.email, "dana@maplefx.ca"))).length).toBe(0);
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("tenant.created");
  });

  it("the new owner can then log in to THEIR tenant", async () => {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "dana@maplefx.ca", password: "a-strong-pass", tenantId: "tnt-maplefx" } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({ id: "dana@maplefx.ca", tenantId: "tnt-maplefx", role: "administrator" });
  });

  it("carries the guided-onboarding config onto the new tenant", async () => {
    const onboarding = { country: "Canada", regulator: "FINTRAC", homeCurrency: "CAD", msbNumber: "M99-1234567", plan: "pro" as const, idThreshold: 5000 };
    const su = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Aspen FX", ownerName: "Sam Lee", email: "sam@aspenfx.ca", password: "a-strong-pass", slug: "aspenfx", onboarding } });
    expect(su.statusCode).toBe(201);
    const code = codeFromLog();
    const ok = await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@aspenfx.ca", code } });
    expect(ok.statusCode).toBe(201);

    const t = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-aspenfx")))[0]!;
    expect(t.plan).toBe("pro");
    expect(t.setup).toMatchObject({ regulator: "FINTRAC", idThreshold: 5000, msbNumber: "M99-1234567" });
    const le = await handle.db.select().from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, "tnt-aspenfx"));
    expect(le[0]!.msbNumber).toBe("M99-1234567");
  });

  it("rejects a taken slug and a reserved slug", async () => {
    const taken = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Other", ownerName: "X", email: "x@other.ca", password: "a-strong-pass", slug: "yorkfx" } });
    expect(taken.statusCode).toBe(409); // yorkfx is the seeded tenant
    const reserved = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Other", ownerName: "X", email: "y@other.ca", password: "a-strong-pass", slug: "admin" } });
    expect(reserved.statusCode).toBe(409);
  });

  it("rejects an email that already owns a desk", async () => {
    const dup = await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "Dupe", ownerName: "Dana", email: "dana@maplefx.ca", password: "a-strong-pass", slug: "maplefx2" } });
    expect(dup.statusCode).toBe(409);
  });

  it("validates the form (bad email, short password, bad slug)", async () => {
    for (const payload of [
      { businessName: "A", ownerName: "B", email: "notanemail", password: "a-strong-pass", slug: "okslug" },
      { businessName: "A", ownerName: "B", email: "ok@ok.ca", password: "short", slug: "okslug" },
      { businessName: "A", ownerName: "B", email: "ok2@ok.ca", password: "a-strong-pass", slug: "-bad-" },
    ]) {
      const r = await app.inject({ method: "POST", url: "/api/signup", payload });
      expect(r.statusCode).toBe(400);
    }
  });
});
