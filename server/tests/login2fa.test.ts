/* Email-verified login: password → emailed code → session, for email-identity
   users; password-only for seeded staff ids with no email on file. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import { sql } from "drizzle-orm";
import { CODE_REFUSAL } from "../src/auth/signin-guard.js";
import { createDb, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { forget as forgetCooldown } from "../src/cooldown.js";

let handle: DbHandle;
let app: FastifyInstance;
let logged: string[] = [];
let appLogs = "";

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  process.env.SEED_PASSWORD = "yorkville";
  // the owner below is a fixture; early access being invite-only is tested
  // in funnel.test.ts, not here
  process.env.EARLY_ACCESS_OPEN = "1";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logged.push(a.join(" ")); });
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db, {}, new Writable({ write(chunk, _encoding, done) { appLogs += chunk.toString(); done(); } }));
  // an email-identity owner to log in as
  await app.inject({ method: "POST", url: "/api/signup", payload: { businessName: "TwoFA FX", ownerName: "Sam Twofa", email: "sam@twofa.ca", password: "a-strong-pass", slug: "twofa" } });
  await app.inject({ method: "POST", url: "/api/signup/verify", payload: { email: "sam@twofa.ca", code: codeFromLog() } });
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); delete process.env.EARLY_ACCESS_OPEN; });
/* The two-minute gap between codes is real now (src/cooldown.ts), and a
   test that asks for two in a row is not a person double-clicking — it is
   a suite deliberately exercising the second one. Clear it between tests,
   and inline wherever one test genuinely needs two sends. */
beforeEach(() => forgetCooldown());
beforeEach(() => { logged = []; appLogs = ""; });

function codeFromLog(): string {
  const line = [...logged].reverse().find((l) => l.includes("[email simulated]"));
  const m = line?.match(/(\d{6}) is your/);
  if (!m) throw new Error("no code in log");
  return m[1]!;
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((x) => x.name === "cdos_session");
const proofCookie = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const value = res.cookies.find((x) => x.name === "cdos_login_proof")?.value;
  if (!value) return {};
  return { cdos_login_proof: value };
};

describe("email-verified login", () => {
  it("email identity: password emails a code, the code grants the session", async () => {
    const start = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "sam@twofa.ca", password: "a-strong-pass" } });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ ok: true, needsCode: true });
    expect(start.json().maskedEmail).toContain("@twofa.ca");
    expect(cookieOf(start)).toBeUndefined(); // NO session until the code is verified

    const code = codeFromLog();
    const wrong = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: "sam@twofa.ca", code: "000000" }, cookies: proofCookie(start) });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: "sam@twofa.ca", code }, cookies: proofCookie(start) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user).toMatchObject({ id: "sam@twofa.ca", tenantId: "tnt-twofa", role: "administrator" });
    expect(cookieOf(ok)).toBeTruthy();
  });

  const startCode = () => app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: "sam@twofa.ca", password: "a-strong-pass" } });
  const checkCode = (cookies: Record<string, string>, code: string, staffId = "sam@twofa.ca") => app.inject({
    method: "POST", url: "/api/auth/login/verify", cookies, payload: { staffId, code, tenantId: "untrusted-tenant" },
  });
  const attempts = async () => (await handle.db.execute(sql`SELECT attempts FROM login_challenges WHERE user_id = 'tnt-twofa:sam@twofa.ca'`)).rows;
  const sessionCount = async () => Number((await handle.db.execute(sql`SELECT count(*) AS n FROM sessions WHERE user_id = 'tnt-twofa:sam@twofa.ca'`)).rows[0]?.n);
  const wrongCode = (code: string) => code === "000000" ? "111111" : "000000";

  it("reports committed remaining guesses, then exhausts on the fifth without offering a sixth", async () => {
    const start = await startCode();
    expect(start.statusCode).toBe(200);
    const cookies = proofCookie(start), code = codeFromLog(), before = await sessionCount();
    for (const remaining of [4, 3, 2, 1]) {
      const response = await checkCode(cookies, wrongCode(code));
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "wrong_code", remainingAttempts: remaining,
        detail: `That code didn’t match. ${remaining} ${remaining === 1 ? "try" : "tries"} left.` });
      expect(response.cookies.length).toBe(0);
      expect(await attempts()).toEqual([{ attempts: 5 - remaining }]);
    }
    const terminal = await checkCode(cookies, wrongCode(code));
    expect(terminal.statusCode).toBe(429);
    expect(terminal.json()).toEqual({ error: "too_many_attempts", detail: "Too many tries. Sign in again." });
    expect(terminal.cookies.some(c => c.name === "cdos_login_proof" && c.value === "")).toBe(true);
    expect(cookieOf(terminal)).toBeUndefined();
    expect(await attempts()).toEqual([]);
    const replay = await checkCode(cookies, code);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual(CODE_REFUSAL);
    expect(await sessionCount()).toBe(before);
  });

  it("accepts the correct code after four committed misses with the server-selected tenant", async () => {
    const start = await startCode();
    expect(start.statusCode).toBe(200);
    const cookies = proofCookie(start), code = codeFromLog();
    for (let n = 0; n < 4; n++) expect((await checkCode(cookies, wrongCode(code))).statusCode).toBe(401);
    const response = await checkCode(cookies, code);
    expect(response.statusCode).toBe(200);
    expect(response.json().user.tenantId).toBe("tnt-twofa");
    expect(!!cookieOf(response)).toBe(true);
    expect(await attempts()).toEqual([]);
  });

  it("never gives remaining guesses or consumes attempts for unproven, mismatched or malformed requests", async () => {
    const start = await startCode();
    expect(start.statusCode).toBe(200);
    const cookies = proofCookie(start), code = codeFromLog();
    for (const response of [
      await checkCode({}, code),
      await checkCode({ cdos_login_proof: "unissued" }, code),
      await checkCode(cookies, code, "unknown@example.test"),
      await checkCode(cookies, code, "m.costa"),
    ]) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(CODE_REFUSAL);
      expect(response.cookies.length).toBe(0);
    }
    for (const payload of [{ code }, { staffId: "sam@twofa.ca", code: "1" }]) {
      const response = await app.inject({ method: "POST", url: "/api/auth/login/verify", cookies, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    }
    expect(await attempts()).toEqual([{ attempts: 0 }]);
    expect((await checkCode(cookies, code)).statusCode).toBe(200);
  });

  it.each([
    { event: "UPDATE", deferred: false, used: 0 },
    { event: "UPDATE", deferred: true, used: 0 },
    { event: "DELETE", deferred: false, used: 4 },
    { event: "DELETE", deferred: true, used: 4 },
  ])("does not report consumption after $event failure (deferred=$deferred)", async ({ event, deferred, used }) => {
    const start = await startCode();
    expect(start.statusCode).toBe(200);
    const cookies = proofCookie(start), code = codeFromLog(), before = await sessionCount();
    await handle.db.execute(sql`UPDATE login_challenges SET attempts = ${used} WHERE user_id = 'tnt-twofa:sam@twofa.ca'`);
    await handle.db.execute(sql.raw("CREATE FUNCTION feedback_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private feedback dependency'; END $$"));
    // event is one of the two fixed test cases; no request data enters this DDL.
    await handle.db.execute(sql.raw(deferred
      ? `CREATE CONSTRAINT TRIGGER feedback_refuse AFTER ${event} ON login_challenges DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION feedback_refuse()`
      : `CREATE TRIGGER feedback_refuse BEFORE ${event} ON login_challenges FOR EACH ROW EXECUTE FUNCTION feedback_refuse()`));
    try {
      const response = await checkCode(cookies, wrongCode(code));
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "temporarily_unavailable" });
      expect(response.cookies.length).toBe(0);
      expect(await attempts()).toEqual([{ attempts: used }]);
      expect(await sessionCount()).toBe(before);
      expect(appLogs.includes('"reason":"signin_dependency_failed"')).toBe(true);
      for (const secret of ["private feedback dependency", "sam@twofa.ca", "a-strong-pass", cookies.cdos_login_proof!]) {
        expect(appLogs.includes(secret), "private authentication data must not reach the app log").toBe(false);
      }
    } finally {
      await handle.db.execute(sql.raw("DROP TRIGGER feedback_refuse ON login_challenges"));
      await handle.db.execute(sql.raw("DROP FUNCTION feedback_refuse()"));
    }
    const retry = await checkCode(cookies, wrongCode(code));
    expect(retry.statusCode).toBe(used === 4 ? 429 : 401);
    if (used === 0) expect(retry.json().remainingAttempts).toBe(4);
    else expect(retry.json()).toEqual({ error: "too_many_attempts", detail: "Too many tries. Sign in again." });
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

  /* The password-only endpoint predates the code step. Left open it was a way
     round it: the right password alone returned a session for an account whose
     second factor is an emailed code. */
  it("the old password-only endpoint cannot be used to skip the code", async () => {
    const bypass = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "sam@twofa.ca", password: "a-strong-pass", tenantId: "tnt-twofa" },
    });
    expect(bypass.statusCode).toBe(403);
    expect(bypass.json().error).toBe("code_required");
    expect(cookieOf(bypass)).toBeUndefined();
  });

  it("but staff with no email still sign in there, since a code was never possible", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "m.costa", password: "yorkville", tenantId: "tnt-yorkfx" },
    });
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)).toBeTruthy();
  });
});
