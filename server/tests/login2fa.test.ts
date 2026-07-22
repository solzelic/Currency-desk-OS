/* Email-verified login: password → emailed code → session, for email-identity
   users; password-only for seeded staff ids with no email on file. */
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
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
  // an email-identity owner to log in as
  await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "TwoFA FX", ownerName: "Sam Twofa", email: "sam@twofa.ca", password: "a-strong-pass", slug: "twofa" } });
  await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@twofa.ca", code: codeFromLog() } });
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });
beforeEach(() => { logged = []; });

function codeFromLog(): string {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/);
  if (!m) throw new Error("no code in log");
  return m[1]!;
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((x) => x.name === "cdos_session");

describe("email-verified login", () => {
  it("email identity: password emails a code, the code grants the session", async () => {
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "sam@twofa.ca", password: "a-strong-pass" } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, needsCode: true });
    expect(start.json().maskedEmail).toContain("@twofa.ca");
    expect(cookieOf(start)).toBeUndefined(); // NO session until the code is verified

    const code = codeFromLog();
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: "sam@twofa.ca", code: "000000" } });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: "sam@twofa.ca", code } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ id: "sam@twofa.ca", tenantId: "tnt-twofa", role: "administrator" });
    expect(cookieOf(ok)).toBeTruthy();
  });

  it("resolves the tenant from the email alone (no tenantId needed)", async () => {
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "sam@twofa.ca", password: "a-strong-pass" } });
    expect(start.json().user.tenantId).toBe("tnt-twofa");
  });

  it("seeded staff with no email sign in on the password alone", async () => {
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" } });
    expect(start.statusCode).toBe(200);
    expect(start.json().needsCode).toBe(false);
    expect(start.json().user).toMatchObject({ id: "m.costa", tenantId: "tnt-yorkfx" });
    expect(cookieOf(start)).toBeTruthy(); // signed in immediately — nowhere to send a code
  });

  it("wrong password is rejected before any code is sent", async () => {
    const bad = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "sam@twofa.ca", password: "nope" } });
    expect(bad.statusCode).toBe(401);
  });
});
