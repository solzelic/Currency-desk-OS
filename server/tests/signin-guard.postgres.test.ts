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
import { CODE_REFUSAL, LOGIN_PROOF_COOKIE, SIGNIN_ACCOUNT_MAX, accountKeyFor, formatLockClock, ipBucket } from "../src/auth/signin-guard.js";
import { isCloudflareIp } from "../src/auth/cloudflare-ips.js";
import { clientIp } from "../src/auth/client-ip.js";
import { applyResetStaffPassword } from "../src/auth/break-glass.js";
import { verifyPassword } from "../src/auth/password.js";
import { forget as forgetCooldown } from "../src/cooldown.js";

const LOCK = /^Too many tries\. Try again in \d+ minutes?\.$/;
const TENANT = "tnt-yorkfx";
const PASS = "correct-horse-signin";
const ACCOUNT_IP = "203.0.113.10";

describe("sign-in address and lock clock", () => {
  it("recognises a Cloudflare edge address and not a caller-chosen one", () => {
    expect(isCloudflareIp("104.16.0.1")).toBe(true);
    expect(isCloudflareIp("2606:4700::1")).toBe(true);
    expect(isCloudflareIp("198.51.100.9")).toBe(false);
    expect(isCloudflareIp("203.0.113.50")).toBe(false);
  });

  it("prints the lock in 12-hour branch time", () => {
    expect(formatLockClock(new Date("2026-10-12T14:42:00.000Z"), "America/Toronto")).toBe("10:42 AM");
  });

  it("counts the socket when a Cloudflare peer sends no usable CF-Connecting-IP", () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      expect(clientIp({ ip: "104.16.0.1", headers: {} })).toBe("104.16.0.1");
      expect(clientIp({ ip: "104.16.0.1", headers: { "cf-connecting-ip": "not-an-ip" } })).toBe("104.16.0.1");
      expect(clientIp({ ip: "104.16.0.1", headers: { "cf-connecting-ip": "2001:db8::1" } })).toBe("2001:db8::1");
      const dumped = warnings.join("\n");
      expect(dumped).toContain("CF-Connecting-IP is missing or not an IP");
      expect(dumped).not.toContain("not-an-ip");
    } finally {
      warn.mockRestore();
    }
  });
});

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
      expect(warnings.join("\n")).toContain("RESEND_API_KEY and EMAIL_FROM are not set");
      expect(warnings.join("\n")).toContain("EMAIL_FROM is not set");
      expect(warnings.join("\n")).toContain("RESEND_API_KEY is not set");
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

  it("still records the provider status when the error body cannot be read", async () => {
    const errors: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    const prev = process.env.NODE_ENV;
    const key = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    const code = "918273";
    try {
      process.env.NODE_ENV = "production";
      process.env.RESEND_API_KEY = "re_test_present";
      process.env.EMAIL_FROM = "CurrencyDesk <noreply@mail.currencydesk.com>";
      vi.stubGlobal("fetch", async () => ({ ok: false, status: 422, text: () => Promise.reject(new Error("body exploded")) }));
      expect(await sendEmail("sam@shop.example", `${code} is your CurrencyDesk sign-in code`, { text: `Your code is ${code}` })).toBe("failed");
      const dumped = errors.join("\n");
      expect(dumped).toContain("422");
      expect(dumped).not.toContain("body exploded");
      expect(dumped).not.toContain(code);
    } finally {
      err.mockRestore();
      vi.unstubAllGlobals();
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
  const accountId = `${TENANT}:r.limit`;
  const emailId = `${TENANT}:rate-limit@example.com`;
  const burstId = `${TENANT}:r.burst`;
  const resetId = `${TENANT}:r.reset`;

  const guess = (staffId: string, password: string, remoteAddress = ACCOUNT_IP) =>
    app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress,
      payload: { staffId, password, tenantId: TENANT },
    });

  const staffIds = [accountId, emailId, burstId, resetId];

  async function wipe(): Promise<void> {
    await pool.query("DELETE FROM login_challenges WHERE user_id = ANY($1::text[])", [staffIds]);
    await pool.query("DELETE FROM sessions WHERE user_id = ANY($1::text[])", [staffIds]);
    await pool.query("DELETE FROM password_resets WHERE user_id = ANY($1::text[])", [staffIds]);
    await pool.query(
      "DELETE FROM signin_failures WHERE bucket LIKE 'ip:203.0.113.%' OR bucket LIKE 'ip:198.51.100.%' OR bucket LIKE 'ip:104.16.%' OR bucket LIKE 'ip:2001:%' OR bucket = 'ip:not-an-ip' OR bucket LIKE 'miss:%' OR bucket = ANY($1::text[])",
      [staffIds.map((id) => `acct:${id}`)],
    );
    await pool.query("DELETE FROM staff_users WHERE id = ANY($1::text[])", [staffIds]);
    await wipeOtherDesk();
  }

  const otherTenant = "tnt-signin-other";
  const otherUser = `${otherTenant}:desk-b-lock@example.com`;

  async function wipeOtherDesk(): Promise<void> {
    await pool.query("DELETE FROM signin_failures WHERE bucket = $1", [`acct:${otherUser}`]);
    await pool.query("DELETE FROM login_challenges WHERE user_id = $1", [otherUser]);
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [otherUser]);
    await pool.query("DELETE FROM password_resets WHERE user_id = $1", [otherUser]);
    await pool.query("DELETE FROM staff_users WHERE id = $1", [otherUser]);
    await pool.query("DELETE FROM branches WHERE id = $1", ["br-signin-other"]);
    await pool.query("DELETE FROM legal_entities WHERE id = $1", ["le-signin-other"]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SEED_PASSWORD = "yorkville";
    handle = await createDb();
    await seed(handle.db);
    app = await buildApp(handle.db);
    pool = new pg.Pool({ connectionString: url });
    await wipe();
    const base = (await handle.db.select().from(schema.staffUsers).limit(1))[0];
    if (!base) throw new Error("seed did not create a staff user to copy");
    const passwordHash = await hashPassword(PASS);
    await handle.db.insert(schema.staffUsers).values([
      { ...base, id: accountId, staffId: "r.limit", name: "Rate Limit", cdId: null, passwordHash, mustChangePassword: false, active: true },
      { ...base, id: emailId, staffId: "rate-limit@example.com", name: "Rate Limit", cdId: null, passwordHash, mustChangePassword: false, active: true },
      { ...base, id: burstId, staffId: "r.burst", name: "Burst", cdId: null, passwordHash, mustChangePassword: false, active: true },
      { ...base, id: resetId, staffId: "r.reset", name: "Reset", cdId: null, passwordHash, mustChangePassword: false, active: true },
    ]);
  });

  afterAll(async () => {
    await wipe();
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
      expect(dumped).toContain("RESEND_API_KEY and EMAIL_FROM are not set");
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

  it("counts the Cloudflare client, and ignores a spoofed CF-Connecting-IP", async () => {
    const chain = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "203.0.113.50, 104.16.0.1", "cf-connecting-ip": "203.0.113.50" },
      payload: { staffId: "cf-client@example.com", password: "wrong-password", tenantId: TENANT },
    });
    expect(chain.statusCode).toBe(401);
    const spoof = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "198.51.100.9", "cf-connecting-ip": "203.0.113.77" },
      payload: { staffId: "spoof-cf@example.com", password: "wrong-password", tenantId: TENANT },
    });
    expect(spoof.statusCode).toBe(401);
    const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket LIKE 'ip:%'")).rows.map((row) => row.bucket);
    expect(buckets).toContain("ip:203.0.113.50");
    expect(buckets).not.toContain("ip:104.16.0.1");
    expect(buckets).toContain("ip:198.51.100.9");
    expect(buckets).not.toContain("ip:203.0.113.77");
  });

  it("keeps counting the socket when a header rotates and nothing is in front", async () => {
    const socket = "203.0.113.70";
    for (let n = 1; n <= 20; n++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        remoteAddress: socket,
        headers: {
          "x-forwarded-for": `198.51.100.${n}, 104.16.0.1`,
          "cf-connecting-ip": `203.0.113.${100 + n}`,
        },
        payload: { staffId: `rotate-${n}@example.com`, password: "wrong-password", tenantId: TENANT },
      });
      expect(res.statusCode, `header ${n}`).toBe(n === 20 ? 429 : 401);
    }
    const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket LIKE 'ip:%'")).rows.map((row) => row.bucket);
    expect(buckets).toContain(`ip:${socket}`);
    expect(buckets.some((bucket) => bucket.startsWith("ip:104.16."))).toBe(false);
    expect(buckets.some((bucket) => /^ip:203\.0\.113\.1\d\d$/.test(bucket))).toBe(false);
  });

  it("answers 401 when a Cloudflare peer omits CF-Connecting-IP", async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        remoteAddress: "104.16.0.4",
        payload: { staffId: "cf-missing@example.com", password: "wrong-password", tenantId: TENANT },
      });
      expect(res.statusCode).toBe(401);
      const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket = $1", ["ip:104.16.0.4"])).rows;
      expect(buckets).toHaveLength(1);
      expect(warnings.join("\n")).toContain("Counting the peer address");
    } finally {
      warn.mockRestore();
    }
  });

  it("counts the peer when CF-Connecting-IP is not an IP, and goes red if that check is removed", async () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/start",
        remoteAddress: "104.16.0.5",
        headers: { "cf-connecting-ip": "not-an-ip" },
        payload: { staffId: "cf-junk@example.com", password: "wrong-password", tenantId: TENANT },
      });
      expect(res.statusCode).toBe(401);
      const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket IN ('ip:104.16.0.5', 'ip:not-an-ip')")).rows.map((row) => row.bucket);
      expect(buckets).toEqual(["ip:104.16.0.5"]);
      expect(warnings.join("\n")).not.toContain("not-an-ip");
    } finally {
      warn.mockRestore();
    }
  });

  it("counts a valid IPv6 CF-Connecting-IP from a Cloudflare peer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login/start",
      remoteAddress: "104.16.0.6",
      headers: { "cf-connecting-ip": "2001:db8::1" },
      payload: { staffId: "cf-v6@example.com", password: "wrong-password", tenantId: TENANT },
    });
    expect(res.statusCode).toBe(401);
    const buckets = (await pool.query("SELECT bucket FROM signin_failures WHERE bucket IN ('ip:2001:db8::1', 'ip:104.16.0.6')")).rows.map((row) => row.bucket);
    expect(buckets).toEqual(["ip:2001:db8::1"]);
  });

  it("checks a password for an unknown id, so dropping the dummy hash fails this", async () => {
    const hash = await hashPassword("not-the-stored-password");
    const median = async (run: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let n = 0; n < 5; n++) {
        const started = performance.now();
        await run();
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return times[2]!;
    };
    const direct = await median(() => verifyPassword("wrong-password", hash));
    const unknown = await median(() => guess(`nobody-${Date.now()}@example.com`, "wrong-password", "203.0.113.91"));
    expect(unknown, `unknown ${unknown.toFixed(1)}ms direct scrypt ${direct.toFixed(1)}ms`).toBeGreaterThan(direct * 0.5);
  });

  it("does not accept a correct password past the limit in a burst of 60", async () => {
    await pool.query("DELETE FROM signin_failures WHERE bucket = $1", [`acct:${burstId}`]);
    await pool.query(
      "INSERT INTO signin_failures (bucket, failures, window_started_at) VALUES ($1, $2, now())",
      [`acct:${burstId}`, SIGNIN_ACCOUNT_MAX - 1],
    );
    const results = await Promise.all(Array.from({ length: 60 }, (_, n) => guess("r.burst", PASS, `203.0.113.${100 + (n % 50)}`)));
    const accepted = results.filter((res) => res.statusCode === 200);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.cookies.find((cookie) => cookie.name === "cdos_session")).toBeTruthy();
    expect(results.filter((res) => res.statusCode === 429).length).toBe(59);
    const again = await guess("r.burst", PASS, "203.0.113.99");
    expect(again.statusCode).toBe(429);
    expect(again.cookies.find((cookie) => cookie.name === "cdos_session")).toBeUndefined();
  }, 60_000);

  it("counts R.LIMIT and r.limit as the same account", async () => {
    await pool.query("DELETE FROM signin_failures WHERE bucket = $1 OR bucket LIKE 'miss:%r.limit'", [`acct:${accountId}`]);
    for (let n = 0; n < 4; n++) expect((await guess("r.limit", "wrong-password", "203.0.113.15")).statusCode).toBe(401);
    const fifth = await guess("R.LIMIT", "wrong-password", "203.0.113.15");
    expect(fifth.statusCode).toBe(429);
    const rows = await pool.query("SELECT bucket, failures FROM signin_failures WHERE bucket = $1 OR bucket LIKE 'miss:%r.limit'", [`acct:${accountId}`]);
    expect(rows.rows.map((row) => row.bucket)).toEqual([`acct:${accountId}`]);
    const correct = await guess("R.LIMIT", PASS, "203.0.113.15");
    expect(correct.statusCode).toBe(429);
  });

  it("lets an owner or a manager unlock, and refuses a teller", async () => {
    await pool.query("DELETE FROM signin_failures WHERE bucket = $1", [`acct:${accountId}`]);
    for (let n = 0; n < 5; n++) expect((await guess("r.limit", "wrong-password", "203.0.113.16")).statusCode).toBe(n === 4 ? 429 : 401);
    const ipBefore = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [ipBucket("203.0.113.16")]);

    const sign = async (staffId: string) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "203.0.113.17",
        payload: { staffId, password: "yorkville", tenantId: TENANT },
      });
      expect(res.statusCode, res.body).toBe(200);
      const cookie = res.cookies.find((item) => item.name === "cdos_session")?.value;
      if (!cookie) throw new Error("no session");
      return cookie;
    };
    const unlock = (cookie: string) => app.inject({
      method: "POST",
      url: "/api/auth/login/unlock",
      remoteAddress: "203.0.113.17",
      cookies: { cdos_session: cookie },
      payload: { staffId: "r.limit" },
    });

    const teller = await unlock(await sign("m.costa"));
    expect(teller.statusCode).toBe(403);
    const still = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [`acct:${accountId}`]);
    expect(Number(still.rows[0]?.failures)).toBeGreaterThanOrEqual(5);

    const manager = await unlock(await sign("r.haddad"));
    expect(manager.statusCode).toBe(200);
    const cleared = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [`acct:${accountId}`]);
    expect(cleared.rows).toHaveLength(0);
    const ipAfter = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [ipBucket("203.0.113.16")]);
    expect(ipAfter.rows[0]?.failures).toBe(ipBefore.rows[0]?.failures);
    const audit = await pool.query("SELECT action, detail FROM audit_events WHERE action = 'auth.login_unlocked' AND detail->>'staffId' = 'r.limit'");
    expect(audit.rows.length).toBeGreaterThan(0);

    for (let n = 0; n < 5; n++) expect((await guess("r.limit", "wrong-password", "203.0.113.18")).statusCode).toBe(n === 4 ? 429 : 401);
    const owner = await unlock(await sign("j.masri"));
    expect(owner.statusCode).toBe(200);
    const open = await guess("r.limit", PASS, "203.0.113.18");
    expect(open.statusCode).toBe(200);
  });

  it("refuses a manager unlocking a person on another desk", async () => {
    await wipeOtherDesk();
    const base = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, accountId)))[0];
    if (!base) throw new Error("r.limit was not seeded");
    await handle.db.insert(schema.tenants).values({ id: otherTenant, name: "Other Desk" });
    await handle.db.insert(schema.legalEntities).values({ id: "le-signin-other", tenantId: otherTenant, name: "Other Entity" });
    await handle.db.insert(schema.branches).values({ id: "br-signin-other", tenantId: otherTenant, legalEntityId: "le-signin-other", name: "Other Branch" });
    await handle.db.insert(schema.staffUsers).values({
      ...base,
      id: otherUser,
      tenantId: otherTenant,
      legalEntityId: "le-signin-other",
      branchId: "br-signin-other",
      staffId: "desk-b-lock@example.com",
      name: "Desk B",
      role: "teller",
      cdId: null,
      authorizedBranchIds: [],
    });
    await pool.query(
      "INSERT INTO signin_failures (bucket, failures, window_started_at) VALUES ($1, 5, now())",
      [`acct:${otherUser}`],
    );
    const signed = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "203.0.113.81",
      payload: { staffId: "r.haddad", password: "yorkville", tenantId: TENANT },
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const cookie = signed.cookies.find((item) => item.name === "cdos_session")?.value;
    if (!cookie) throw new Error("no session");
    const unlocked = await app.inject({
      method: "POST",
      url: "/api/auth/login/unlock",
      remoteAddress: "203.0.113.81",
      cookies: { cdos_session: cookie },
      payload: { staffId: "desk-b-lock@example.com" },
    });
    expect(unlocked.statusCode).toBe(404);
    const left = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [`acct:${otherUser}`]);
    expect(Number(left.rows[0]?.failures)).toBe(5);
    await wipeOtherDesk();
  });

  it("clears the lock when RESET_STAFF_PASSWORD resets the password", async () => {
    await pool.query(
      "INSERT INTO signin_failures (bucket, failures, window_started_at) VALUES ($1, 5, now()) ON CONFLICT (bucket) DO UPDATE SET failures = 5, window_started_at = now()",
      [`acct:${resetId}`],
    );
    expect(await applyResetStaffPassword(handle.db, "R.Reset:new-password-1")).toBe("reset");
    const left = await pool.query("SELECT failures FROM signin_failures WHERE bucket = $1", [`acct:${resetId}`]);
    expect(left.rows).toHaveLength(0);
    const res = await guess("r.reset", "new-password-1", "203.0.113.19");
    expect(res.statusCode).toBe(200);
  });
});
