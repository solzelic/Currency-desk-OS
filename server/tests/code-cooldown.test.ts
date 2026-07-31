/* How soon somebody may ask for another one-time code.

   Four buttons send a six-digit code, and the failure mode is not abuse —
   it is an ordinary person. A button that looks like it did nothing gets
   pressed again, and again, and the inbox fills with codes of which only
   the LAST one works. So the code somebody carefully reads out is the one
   that fails, and they ring up to say the product is broken.

   /api/auth/login/start had no limit of any kind before this: every press
   of "Send my code" sent another email.

   The gap is two minutes, per identity, and it lives in one file so the
   four routes cannot drift apart. The hourly caps are a different thing
   and stay where they are — that one is about somebody working through a
   list, this one is about a finger.
*/
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forget, CODE_GAP_MS } from "../src/cooldown.js";

let handle: DbHandle; let app: FastifyInstance; let admin: Record<string, string> = {};
const TENANT = "tnt-yorkfx";
const PASS = "a-strong-pass-2026";
const logged = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));
const clearLog = () => { (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0; };

let made = 0;
async function anOwner(): Promise<string> {
  const email = `cool-${++made}@cooldown.example`;
  const base = (await handle.db.select().from(schema.staffUsers))[0]!;
  const { hashPassword } = await import("../src/auth/password.js");
  await handle.db.insert(schema.staffUsers).values({
    ...base, id: `${TENANT}:${email}`, staffId: email, name: "Dana Okafor", cdId: null,
    passwordHash: await hashPassword(PASS),
  });
  return email;
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville"; process.env.PLATFORM_ADMIN_EMAILS = "j.masri";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { staffId: "j.masri", password: "yorkville", tenantId: TENANT } });
  const c = r.cookies.find((x) => x.name === "cdos_session");
  admin = c ? { cdos_session: c.value } : {};
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.PLATFORM_ADMIN_EMAILS; });
beforeEach(() => forget());

const start = (staffId: string) =>
  app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId, password: PASS, tenantId: TENANT } as Record<string, unknown> });
const forgot = (email: string) =>
  app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email, tenantId: TENANT } as Record<string, unknown> });

describe("signing in", () => {
  it("sends the first one", async () => {
    const owner = await anOwner();
    const res = await start(owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().needsCode).toBe(true);
  });

  it("refuses a second within two minutes, and says how long", async () => {
    const owner = await anOwner();
    expect((await start(owner)).statusCode).toBe(200);
    const again = await start(owner);
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe("too_soon");
    // the countdown the screen renders
    expect(again.json().retryAfter).toBeGreaterThan(0);
    expect(again.json().retryAfter).toBeLessThanOrEqual(CODE_GAP_MS / 1000);
    expect(again.json().detail).toMatch(/moments ago/);
  });

  /* The real bug: two codes in one inbox, only the second one working.
     Somebody reads the first out and is told it is wrong. */
  it("does not put a second code in the inbox", async () => {
    const owner = await anOwner();
    clearLog();
    await start(owner);
    await start(owner);
    await start(owner);
    expect(logged().filter((l) => l.includes(`to=${owner}`)).length).toBe(1);
  });

  /* Double-click. Both requests are in flight before either has finished,
     which is exactly what an impatient press produces and what a `disabled`
     attribute alone does not stop. */
  it("survives two presses landing at once", async () => {
    const owner = await anOwner();
    clearLog();
    const [a, b] = await Promise.all([start(owner), start(owner)]);
    const codes = logged().filter((l) => l.includes(`to=${owner}`)).length;
    expect(codes).toBe(1);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 429]);
  });

  it("lets them through once the gap has passed", async () => {
    const owner = await anOwner();
    expect((await start(owner)).statusCode).toBe(200);
    forget("login:" + `${TENANT}:${owner}`);
    expect((await start(owner)).statusCode).toBe(200);
  });

  it("is per person, not global", async () => {
    const one = await anOwner(); const two = await anOwner();
    expect((await start(one)).statusCode).toBe(200);
    expect((await start(two)).statusCode).toBe(200);
  });
});

describe("resetting a password", () => {
  it("waits the same two minutes", async () => {
    const owner = await anOwner();
    expect((await forgot(owner)).statusCode).toBe(200);
    const again = await forgot(owner);
    expect(again.statusCode).toBe(429);
    expect(again.json().retryAfter).toBeGreaterThan(0);
  });

  /* The cooldown must not become the thing that leaks what the route
     refuses to say: if a known address were held back and an unknown one
     let straight through, the difference IS the answer. */
  it("holds an unknown address back exactly as it holds a real one", async () => {
    const owner = await anOwner();
    await forgot(owner);
    await forgot("stranger@nowhere.example");
    const real = await forgot(owner);
    const fake = await forgot("stranger@nowhere.example");
    expect(fake.statusCode).toBe(real.statusCode);
    expect(fake.json().error).toBe(real.json().error);
  });
});

describe("confirming a desk during setup", () => {
  it("shares one gap between the applicant's screen and the panel's button", async () => {
    await app.inject({ method: "POST", url: "/api/enquiries",
      payload: { kind: "early_access", email: "setup@cooldown.example", name: "Dana", details: { jurisdiction: "CA" } } as Record<string, unknown> });
    const row = (await handle.db.select().from(schema.enquiries)).find((e) => e.email === "setup@cooldown.example")!;
    await app.inject({ method: "PATCH", url: `/api/admin/enquiries/${row.id}`, cookies: admin, payload: { status: "invited" } as Record<string, unknown> });
    await app.inject({ method: "PUT", url: `/api/onboarding/${row.reference}/state`,
      payload: { at: 3, data: { ownerEmail: "setup@cooldown.example" } } as Record<string, unknown> });

    forget();
    const theirs = await app.inject({ method: "POST", url: `/api/onboarding/${row.reference}/verify/send`, payload: { data: {} } as Record<string, unknown> });
    expect(theirs.statusCode).toBe(200);
    /* An operator on the phone pressing "Send them a code" right after
       they pressed it themselves must not put a second one in the inbox. */
    const ours = await app.inject({ method: "POST", url: `/api/admin/enquiries/${row.id}/verify-code`, cookies: admin, payload: {} as Record<string, unknown> });
    expect(ours.statusCode).toBe(429);
    expect(ours.json().error).toBe("too_soon");
  });
});
