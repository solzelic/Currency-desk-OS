/* Shop sign-in: password guesses are counted in Postgres, the emailed-code
   step does not say whether a staff id exists, and production does not
   write a code into the log when mail is not configured.

   The Postgres cases run only with TEST_DATABASE_URL, the same gate as
   the other invariant files. The log case does not need a database and
   runs either way. */
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { sendEmail } from "../src/email.js";
import { CODE_REFUSAL, LOGIN_PROOF_COOKIE, accountKeyFor, ipBucket } from "../src/auth/signin-guard.js";
import { forget as forgetCooldown } from "../src/cooldown.js";

const LOCK = /^Too many tries\. Try again in \d+ minutes?\.$/;
const TENANT = "tnt-yorkfx";
const PASS = "correct-horse-signin";
const ACCOUNT_IP = "203.0.113.10";

describe("production does not log a sign-in code", () => {
  it("refuses the send when RESEND_API_KEY or EMAIL_FROM is missing", async () => {
    const code = "918273";
    const warnings: string[] = [];
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const prev = process.env.NODE_ENV;
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      expect(await sendEmail("sam@shop.example", `${code} is your CurrencyDesk sign-in code`, { text: `Your code is ${code}` })).toBe("failed");
      process.env.RESEND_API_KEY = "re_test_present";
      expect(await sendEmail("sam@shop.example", `${code} is your CurrencyDesk sign-in code`, { text: `Your code is ${code}` })).toBe("failed");
      delete process.env.RESEND_API_KEY;
      process.env.EMAIL_FROM = "CurrencyDesk <noreply@mail.currencydesk.com>";
      expect(await sendEmail("sam@shop.example", `${code} is your CurrencyDesk sign-in code`, { text: `Your code is ${code}` })).toBe("failed");
      const dumped = `${warnings.join("\n")}\n${logs.join("\n")}`;
      expect(dumped).not.toContain(code);
      expect(dumped).not.toContain("sam@shop.example");
      expect(warnings.join("\n")).toContain("RESEND_API_KEY");
      expect(warnings.join("\n")).toContain("EMAIL_FROM");
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      if (key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = key;
      if (from === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = from;
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;

postgres("shop sign-in against Postgres", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let pool: pg.Pool;
  let accountId = "";
  let emailId = "";

  const guess = (staffId: string, password: string, remoteAddress = ACCOUNT_IP) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress,
      payload: { staffId, password, tenantId: TENANT },
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SEED_PASSWORD = "yorkville";
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    pool = new pg.Pool({ connectionString: url });
    const base = (await handle.db.select().from(schema.staffUsers).limit(1))[0];
    if (!base) throw new Error("seed did not create a staff user to copy");
    const passwordHash = await hashPassword(PASS);
    accountId = `${TENANT}:r.limit`;
    emailId = `${TENANT}:rate-limit@example.com`;
    await handle.db.insert(schema.staffUsers).values([
      { ...base, id: accountId, staffId: "r.limit", name: "Rate Limit", cdId: null, passwordHash, mustChangePassword: false, active: true },
      { ...base, id: emailId, staffId: "rate-limit@example.com", name: "Rate Limit", cdId: null, passwordHash, mustChangePassword: false, active: true },
    ]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM signin_failures WHERE bucket LIKE 'ip:203.0.113.%' OR bucket LIKE 'ip:198.51.100.%' OR bucket LIKE 'miss:%' OR bucket = $1 OR bucket = $2", [`acct:${accountId}`, `acct:${emailId}`]);
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [[accountId, emailId]]);
    await pool.query("DELETE FROM password_resets WHERE user_id = ANY($1::text[])", [[accountId, emailId]]);
    await pool.query("DELETE FROM staff_users WHERE id = ANY($1::text[])", [[accountId, emailId]]);
    await pool.end();
    await app.close();
    await handle.close();
    delete process.env.DATABASE_URL;
  });

  it("locks the account on the fifth wrong password and keeps the lock after a new process", async () => {
    for (let n = 1; n <= 4; n++) {
      const res = await guess("r.limit", "wrong-password");
      expect(res.statusCode, `attempt ${n}`).toBe(401);
      expect(res.json()).toEqual({ error: "invalid_credentials" });
    }
    const fifth = await guess("r.limit", "wrong-password");
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().detail).toBe("Too many tries. Try again in 15 minutes.");
    expect(fifth.json().error).toBe("too_many_attempts");

    const events = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, accountId));
    expect(events.filter((event) => event.action === "auth.login_failed").length).toBeGreaterThanOrEqual(4);
    const locked = events.filter((event) => event.action === "auth.login_locked");
    expect(locked.length).toBeGreaterThanOrEqual(1);
    expect(locked[0]?.detail).toMatchObject({ scope: "account" });
    expect(JSON.stringify(locked)).not.toContain("wrong-password");
    expect(JSON.stringify(locked)).not.toContain(PASS);

    const stored = await handle.db.select().from(schema.signinFailures).where(eq(schema.signinFailures.bucket, accountKeyFor(accountId, TENANT, "r.limit")));
    expect(stored[0]?.failures).toBeGreaterThanOrEqual(5);

    await app.close();
    app = await buildApp(handle.db);
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: ACCOUNT_IP,
      payload: { staffId: "r.limit", password: PASS, tenantId: TENANT },
    });
    expect(again.statusCode).toBe(429);
    expect(again.json().detail).toMatch(LOCK);
    expect(again.cookies.find((cookie) => cookie.name === "cdos_session")).toBeUndefined();
  });

  it("an unknown id locks with the same sentence", async () => {
    const unknown = "nobody-signin@example.com";
    let last: { statusCode: number; body: { detail?: string; error?: string } } | undefined;
    for (let n = 0; n < 5; n++) {
      const res = await guess(unknown, "wrong-password", "203.0.113.11");
      last = { statusCode: res.statusCode, body: res.json() };
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.body.detail).toMatch(LOCK);
    expect(last?.body.error).toBe("too_many_attempts");
  });

  it("counts the address, including the hop a proxy appended", async () => {
    await handle.db.insert(schema.signinFailures).values({
      bucket: ipBucket("203.0.113.20"),
      failures: 19,
      windowStartedAt: new Date(),
    });
    const locked = await guess("fresh-ip@example.com", "wrong-password", "203.0.113.20");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().detail).toMatch(LOCK);

    const other = await guess("fresh-ip-2@example.com", "wrong-password", "203.0.113.21");
    expect(other.statusCode).toBe(401);

    const forwarded = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "1.1.1.1, 198.51.100.9" },
      payload: { staffId: "forwarded@example.com", password: "wrong-password", tenantId: TENANT },
    });
    expect(forwarded.statusCode).toBe(401);
    const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket LIKE 'ip:%'")).rows.map((row) => row.bucket);
    expect(buckets).toContain("ip:198.51.100.9");
    expect(buckets).not.toContain("ip:1.1.1.1");
    expect(buckets).not.toContain("ip:10.0.0.8");
  });

  it("opens the window again after fifteen minutes, and a success clears the account", async () => {
    await handle.db.update(schema.signinFailures)
      .set({ windowStartedAt: new Date(Date.now() - 16 * 60 * 1000), failures: 5 })
      .where(eq(schema.signinFailures.bucket, accountKeyFor(accountId, TENANT, "r.limit")));
    const reset = await guess("r.limit", "wrong-password");
    expect(reset.statusCode).toBe(401);
    const row = (await handle.db.select().from(schema.signinFailures).where(eq(schema.signinFailures.bucket, accountKeyFor(accountId, TENANT, "r.limit"))))[0];
    expect(row?.failures).toBe(1);

    for (let n = 0; n < 3; n++) expect((await guess("r.limit", "wrong-password")).statusCode).toBe(401);
    const ok = await guess("r.limit", PASS);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().needsCode).toBe(false);
    for (let n = 0; n < 4; n++) expect((await guess("r.limit", "wrong-password")).statusCode).toBe(401);
  });

  it("returns the same words and the same time for an unknown id and a wrong code", async () => {
    forgetCooldown();
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
    try {
      const start = await guess("rate-limit@example.com", PASS, "203.0.113.30");
      expect(start.statusCode, start.body).toBe(200);
      expect(start.json().needsCode).toBe(true);
      const proof = start.cookies.find((cookie) => cookie.name === LOGIN_PROOF_COOKIE)?.value;
      expect(proof).toBeTruthy();
      const code = [...logged].reverse().join("\n").match(/(\d{6}) is your/)?.[1];
      if (!code) throw new Error("sign-in code was not in the simulated mail log");

      const stored = (await handle.db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.userId, emailId)))[0];
      expect(stored?.codeHash).toBeTruthy();
      expect(stored?.codeHash).not.toContain(code);
      expect(stored?.tokenHash).not.toBe(proof);

      const wrong = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        remoteAddress: "203.0.113.30",
        cookies: { [LOGIN_PROOF_COOKIE]: proof! },
        payload: { staffId: "rate-limit@example.com", code: "000000", tenantId: TENANT },
      });
      const bare = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        remoteAddress: "203.0.113.31",
        payload: { staffId: "rate-limit@example.com", code, tenantId: TENANT },
      });
      const unknown = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        remoteAddress: "203.0.113.32",
        payload: { staffId: "not-a-person@example.com", code: "000000", tenantId: TENANT },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual(CODE_REFUSAL);
      expect(bare.json()).toEqual(wrong.json());
      expect(unknown.json()).toEqual(wrong.json());
      expect(bare.statusCode).toBe(wrong.statusCode);
      expect(unknown.statusCode).toBe(wrong.statusCode);

      const sample = async (staffId: string) => {
        const times: number[] = [];
        let body: unknown;
        let status = 0;
        for (let n = 0; n < 11; n++) {
          const started = performance.now();
          const res = await app.inject({
            method: "POST",
            url: "/api/auth/login/verify",
            remoteAddress: "203.0.113.40",
            payload: { staffId, code: "111111", tenantId: TENANT },
          });
          times.push(performance.now() - started);
          status = res.statusCode;
          body = res.json();
        }
        times.sort((a, b) => a - b);
        return { status, body, median: times[5]! };
      };
      await sample("warmup@example.com");
      const known = await sample("rate-limit@example.com");
      const stranger = await sample("stranger-signin@example.com");
      expect(known.status).toBe(stranger.status);
      expect(known.body).toEqual(stranger.body);
      expect(known.body).toEqual(CODE_REFUSAL);
      const gap = Math.abs(known.median - stranger.median);
      expect(gap, `medians known=${known.median.toFixed(1)}ms stranger=${stranger.median.toFixed(1)}ms`).toBeLessThan(Math.max(known.median, stranger.median) * 0.75 + 30);

      const mismatched = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        remoteAddress: "203.0.113.30",
        cookies: { [LOGIN_PROOF_COOKIE]: proof! },
        payload: { staffId: "not-a-person@example.com", code, tenantId: TENANT },
      });
      expect(mismatched.statusCode).toBe(401);
      expect(mismatched.json()).toEqual(CODE_REFUSAL);
      expect(mismatched.cookies.find((cookie) => cookie.name === "cdos_session")).toBeUndefined();

      const ok = await app.inject({
        method: "POST",
        url: "/api/auth/login/verify",
        remoteAddress: "203.0.113.30",
        cookies: { [LOGIN_PROOF_COOKIE]: proof! },
        payload: { staffId: "rate-limit@example.com", code, tenantId: TENANT },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.cookies.find((cookie) => cookie.name === "cdos_session")).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not send or log a code in production when mail is not configured", async () => {
    forgetCooldown();
    const prev = process.env.NODE_ENV;
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    const warnings: string[] = [];
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    try {
      process.env.NODE_ENV = "production";
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_FROM;
      const res = await guess("rate-limit@example.com", PASS, "203.0.113.50");
      expect(res.statusCode).toBe(503);
      expect(res.body).not.toMatch(/\d{6}/);
      const dumped = `${warnings.join("\n")}\n${logs.join("\n")}`;
      expect(dumped).not.toMatch(/\d{6}/);
      expect(dumped).toContain("EMAIL_FROM");
      const left = await handle.db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.userId, emailId));
      expect(left).toHaveLength(0);
    } finally {
      warn.mockRestore();
      log.mockRestore();
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
      if (key === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = key;
      if (from === undefined) delete process.env.EMAIL_FROM;
      else process.env.EMAIL_FROM = from;
    }
  });
});
