/* Getting back in after forgetting the password.

   There was no route at all. The sign-in screen told the owner "the owner
   can reset it" — and the owner is the owner — so the only working path
   was ringing the platform team, who read a temporary password down the
   line. Fine at forty desks; a Saturday-morning support call at four
   hundred, while somebody's shop is opening.

   Two rules make a reset flow safe rather than a liability, and both are
   easy to get wrong in ways nothing visibly breaks:

     · THE ANSWER IS THE SAME EITHER WAY. If "no account here" looks
       different from "sent", the form is a way to ask whether a given shop
       banks with CurrencyDesk, one address at a time.

     · A RESET KILLS EVERY SESSION. Changing the password while whoever
       prompted the reset stays signed in is theatre.

   And the thing that makes six digits enough: the code dies on the fifth
   wrong guess, so a million-wide space is never walked.
*/
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";

let handle: DbHandle; let app: FastifyInstance;
const TENANT = "tnt-yorkfx";
const PASS = "the-old-one-2026";
const NEW = "a-brand-new-one-2026";
const logged = () => (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0] ?? ""));
const clearLog = () => { (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0; };

const forgot = (email: string) =>
  app.inject({ method: "POST", url: "/api/auth/forgot", payload: { email, tenantId: TENANT } as Record<string, unknown> });
const reset = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/auth/reset", payload: { tenantId: TENANT, ...payload } });
const codeFromLog = (addr: string) => {
  const line = logged().reverse().find((l) => l.includes(`to=${addr}`) && /\b\d{6}\b/.test(l));
  return line?.match(/\b(\d{6})\b/)?.[1] ?? "";
};

/* A fresh owner per test.

   Asking for a reset is throttled to five an hour PER ADDRESS, which is
   the point of it — so a suite that reused one address would spend the
   budget in the second test and then measure the throttle instead of the
   thing it meant to. Each test gets somebody new, exactly as each of them
   would be a different person. */
let made = 0;
async function anOwner(): Promise<string> {
  const email = `owner-${++made}@resettest.example`;
  const base = (await handle.db.select().from(schema.staffUsers))[0]!;
  const { hashPassword } = await import("../src/auth/password.js");
  await handle.db.insert(schema.staffUsers).values({
    ...base, id: `${TENANT}:${email}`, staffId: email, name: "Dana Okafor", cdId: null,
    passwordHash: await hashPassword(PASS),
  });
  return email;
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1"; process.env.SEED_PASSWORD = "yorkville";
  vi.spyOn(console, "log").mockImplementation(() => {});
  handle = await createDb(); await seed(handle.db); app = await buildApp(handle.db);
});
afterAll(async () => { await app.close(); await handle.close(); vi.restoreAllMocks(); });

describe("asking for a reset", () => {
  it("emails a code to somebody who has an account", async () => {
    const OWNER = await anOwner();
    clearLog();
    expect((await forgot(OWNER)).statusCode).toBe(200);
    expect(codeFromLog(OWNER)).toMatch(/^\d{6}$/);
  });

  /* The whole reason this route says so little. */
  it("answers a stranger exactly as it answers a customer", async () => {
    const OWNER = await anOwner();
    const known = await forgot(OWNER);
    const unknown = await forgot("nobody@nowhere.example");
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
  });

  it("says nothing about an address that is not even an address", async () => {
    const res = await forgot("not-an-address");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("sends nothing to a stranger", async () => {
    clearLog();
    await forgot("nobody@nowhere.example");
    expect(logged().some((l) => l.includes("nobody@nowhere.example"))).toBe(false);
  });

  it("is on the record when it is real", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("auth.reset_requested");
  });

  it("kills the previous code, so “ask for another” is always safe", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const first = codeFromLog(OWNER);
    clearLog();
    await forgot(OWNER);
    const second = codeFromLog(OWNER);
    expect(second).not.toBe(first);
    expect((await reset({ email: OWNER, code: first, newPassword: NEW })).statusCode).toBe(401);
  });
});

describe("using the code", () => {
  it("refuses a wrong one, and says the same thing every time", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const wrong = await reset({ email: OWNER, code: "000000", newPassword: NEW });
    const stranger = await reset({ email: "nobody@nowhere.example", code: "000000", newPassword: NEW });
    expect(wrong.statusCode).toBe(401);
    expect(stranger.statusCode).toBe(401);
    expect(stranger.body).toBe(wrong.body);
  });

  /* What makes six digits enough. */
  it("dies on the fifth wrong guess rather than waiting to be walked", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const code = codeFromLog(OWNER);
    for (let i = 0; i < 5; i++) await reset({ email: OWNER, code: "000001", newPassword: NEW });
    // the real code no longer works either — the attempt budget is spent
    expect((await reset({ email: OWNER, code, newPassword: NEW })).statusCode).toBe(401);
  });

  it("refuses a password too short to be worth setting", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const code = codeFromLog(OWNER);
    expect((await reset({ email: OWNER, code, newPassword: "short" })).statusCode).toBe(400);
  });

  it("sets the new password, and the old one stops working", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const code = codeFromLog(OWNER);
    const res = await reset({ email: OWNER, code, newPassword: NEW });
    expect(res.statusCode).toBe(200);
    expect(res.json().signInAs).toBe(OWNER);

    const old = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: OWNER, password: PASS, tenantId: TENANT } as Record<string, unknown> });
    expect(old.statusCode).toBe(401);
    const now = await app.inject({ method: "POST", url: "/api/auth/login/start", payload: { staffId: OWNER, password: NEW, tenantId: TENANT } as Record<string, unknown> });
    expect(now.statusCode).toBe(200);
  });

  it("works once — the same code cannot be replayed", async () => {
    const OWNER = await anOwner();
    clearLog();
    await forgot(OWNER);
    const code = codeFromLog(OWNER);
    expect((await reset({ email: OWNER, code, newPassword: NEW })).statusCode).toBe(200);
    expect((await reset({ email: OWNER, code, newPassword: "another-one-2026" })).statusCode).toBe(401);
  });

  it("is on the record", async () => {
    const actions = (await handle.db.select().from(schema.auditEvents)).map((e) => e.action);
    expect(actions).toContain("auth.reset_completed");
  });
});

/* A password change that leaves the thief signed in is theatre. */
describe("what a reset does to the devices already signed in", () => {
  it("signs every one of them out", async () => {
    const OWNER = await anOwner();
    const id = `${TENANT}:${OWNER}`;
    const { createSession } = await import("../src/auth/sessions.js");
    await createSession(handle.db, id);
    await createSession(handle.db, id);
    const live = async () =>
      (await handle.db.select().from(schema.sessions).where(eq(schema.sessions.userId, id)))
        .filter((s) => !s.revokedAt).length;
    expect(await live()).toBeGreaterThan(0);

    clearLog();
    await forgot(OWNER);
    const code = codeFromLog(OWNER);
    expect((await reset({ email: OWNER, code, newPassword: "yet-another-one-2026" })).statusCode).toBe(200);
    expect(await live()).toBe(0);
  });
});

/* Somebody working through a list of addresses is a different visitor from
   somebody who forgot their own password, and the difference is volume. */
describe("throttling", () => {
  it("stops one address being asked for over and over", async () => {
    let last = 200;
    for (let i = 0; i < 8; i++) {
      last = (await forgot("throttle@resettest.example")).statusCode;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
