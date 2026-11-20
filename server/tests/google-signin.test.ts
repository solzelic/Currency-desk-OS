/* CD-275. Google sign-in and link, with a mock provider and no network.
   The demo shop is never linked. An owner without a second step gets
   the same refusal as a missing account. */
import { createHash, generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Secret, TOTP } from "otpauth";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { seed, DEMO } from "../src/seed.js";
import { clearJwksCache, type FetchJson } from "../src/auth/oidc.js";
import { confirmOwner, setSsoHttp, spendPendingChallenge } from "../src/auth/sso-flow.js";
import { normalizeBackupCode, regenerateRecoveryCodes, verifyOwnerFactor } from "../src/auth/owner-mfa.js";
import { SIGNIN_IP_MAX } from "../src/auth/signin-guard.js";

const ORIGIN = "https://currencydesk-staging.onrender.com";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "g1", alg: "RS256", use: "sig" };
let nextClaims: Record<string, unknown> = {};

function idToken(claims: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "g1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${signData("RSA-SHA256", Buffer.from(`${h}.${p}`), rsa.privateKey).toString("base64url")}`;
}

const http: FetchJson = async (url, init) => {
  if (url.includes("certs") || url.includes("keys")) return { keys: [jwk] };
  if (init.method === "POST") {
    return { id_token: idToken(nextClaims), access_token: "ya29-test-token", refresh_token: "refresh-secret" };
  }
  throw new Error(`unexpected ${url}`);
};

let handle: DbHandle;
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  for (const key of ["SIGNIN_GOOGLE", "SIGNIN_MICROSOFT", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SSO_SIGNIN_REDIRECT_URI", "SSO_LINK_REDIRECT_URI"]) {
    saved[key] = process.env[key];
  }
  process.env.SIGNIN_GOOGLE = "1";
  process.env.GOOGLE_CLIENT_ID = "google-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-secret";
  process.env.SSO_SIGNIN_REDIRECT_URI = `${ORIGIN}/auth/sso/callback`;
  process.env.SSO_LINK_REDIRECT_URI = `${ORIGIN}/auth/sso/link/callback`;
  handle = await createDb();
  await seed(handle.db);
  await handle.db.insert(schema.tenants).values({ id: "tnt-platform", name: "CurrencyDesk Platform" }).onConflictDoNothing();
  app = await buildApp(handle.db);
  setSsoHttp(http);
});

afterAll(async () => {
  setSsoHttp(null);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await app.close();
  await handle.close();
});

async function makePerson(role: "teller" | "administrator", subject: string) {
  const id = randomUUID().slice(0, 8);
  const tenantId = `tnt-${id}`;
  const legalEntityId = `le-${id}`;
  const branchId = `br-${id}`;
  const userId = `${tenantId}:person`;
  await handle.db.insert(schema.tenants).values({ id: tenantId, name: `Desk ${id}` });
  await handle.db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: `LE ${id}`, jurisdiction: "FINTRAC" });
  await handle.db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Main", province: "ON" });
  await handle.db.insert(schema.staffUsers).values({
    id: userId,
    tenantId,
    legalEntityId,
    branchId,
    staffId: "person",
    name: "Person",
    role,
    authorizedBranchIds: [branchId],
    passwordHash: await hashPassword("correct-horse"),
  });
  if (subject) {
    await handle.db.insert(schema.staffIdentities).values({
      id: `idn-${id}`,
      tenantId,
      staffUserId: userId,
      provider: "google",
      issuer: "https://accounts.google.com",
      subject,
    });
  }
  return { tenantId, userId };
}

async function start(path: string, cookie?: string) {
  clearJwksCache();
  const res = await app.inject({ method: "GET", url: path, headers: cookie ? { cookie } : {} });
  expect(res.statusCode).toBe(302);
  const loc = new URL(res.headers.location as string);
  return { state: loc.searchParams.get("state") ?? "", nonce: loc.searchParams.get("nonce") ?? "" };
}

function claims(nonce: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  nextClaims = {
    iss: "https://accounts.google.com",
    sub,
    aud: "google-client",
    exp: now + 300,
    iat: now,
    nonce,
    email: "hidden@example.com",
    email_verified: true,
  };
}

async function readyOwner(subject: string) {
  const person = await makePerson("administrator", subject);
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { staffId: "person", password: "correct-horse", tenantId: person.tenantId },
  });
  const cookie = cookieFrom(login, "cdos_session");
  await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
  const started = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
  const enroll = started.json() as { ticket: string; manualSecret: string; backupCodes: string[] };
  const code = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(enroll.manualSecret) }).generate();
  expect((await app.inject({
    method: "POST",
    url: "/api/auth/mfa/enroll/confirm",
    headers: { cookie },
    payload: { ticket: enroll.ticket, code },
  })).statusCode).toBe(200);
  const begun = await start("/api/auth/sso/google/start");
  claims(begun.nonce, subject);
  const confirm = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${begun.state}` });
  expect(confirm.headers.location).toBe("/login?sso=confirm");
  return { person, pending: cookieFrom(confirm, "cdos_sso_pending"), backup: enroll.backupCodes[0] ?? "" };
}

function cookieFrom(res: { headers: { "set-cookie"?: string | string[] } }, name: string): string {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join(";") : String(raw ?? "");
  const token = new RegExp(`${name}=([^;]+)`).exec(joined)?.[1];
  return token ? `${name}=${token}` : "";
}

describe("Google sign-in", () => {
  it("stays unavailable when the flag is off", async () => {
    process.env.SIGNIN_GOOGLE = "0";
    const res = await app.inject({ method: "GET", url: "/api/auth/sso/google/start" });
    expect(res.statusCode).toBe(503);
    const callback = await app.inject({ method: "GET", url: "/auth/sso/callback?code=x&state=y" });
    expect(callback.statusCode).toBe(503);
    process.env.SIGNIN_GOOGLE = "1";
  });

  it("signs in a linked teller and refuses a missing or inactive account the same way", async () => {
    const subject = `sub-${randomUUID()}`;
    const person = await makePerson("teller", subject);
    const beforeStaff = await handle.db.execute(sql`SELECT count(*)::int AS n FROM staff_users`);
    const beforeTenants = await handle.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
    const begun = await start("/api/auth/sso/google/start?returnTo=/app");
    claims(begun.nonce, subject);
    const ok = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${begun.state}` });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/app");
    expect(String(ok.headers["set-cookie"])).toContain("cdos_session=");

    const missing = await start("/api/auth/sso/google/start");
    claims(missing.nonce, `missing-${randomUUID()}`);
    const no = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${missing.state}` });
    expect(no.statusCode).toBe(303);
    expect(no.headers.location).toBe("/login?sso=refused");
    expect(String(no.headers["set-cookie"] ?? "")).not.toContain("cdos_session=");

    await handle.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.id, person.userId));
    const inactiveStart = await start("/api/auth/sso/google/start");
    claims(inactiveStart.nonce, subject);
    const inactive = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${inactiveStart.state}` });
    expect(inactive.headers.location).toBe("/login?sso=refused");
    const afterStaff = await handle.db.execute(sql`SELECT count(*)::int AS n FROM staff_users`);
    const afterTenants = await handle.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
    expect(afterStaff.rows[0]).toEqual(beforeStaff.rows[0]);
    expect(afterTenants.rows[0]).toEqual(beforeTenants.rows[0]);
    const stored = JSON.stringify(await handle.db.select().from(schema.authChallenges));
    expect(stored).not.toContain("ya29-test-token");
    expect(stored).not.toContain("refresh-secret");
  });

  it("refuses an owner until the second step exists, then requires that code", async () => {
    const subject = `owner-${randomUUID()}`;
    const person = await makePerson("administrator", subject);
    const blocked = await start("/api/auth/sso/google/start");
    claims(blocked.nonce, subject);
    const refused = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${blocked.state}` });
    expect(refused.headers.location).toBe("/login?sso=refused");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "person", password: "correct-horse", tenantId: person.tenantId },
    });
    const cookie = cookieFrom(login, "cdos_session");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
    const started = await app.inject({ method: "POST", url: "/api/auth/mfa/enroll/start", headers: { cookie } });
    const enroll = started.json() as { ticket: string; manualSecret: string; backupCodes: string[] };
    const code = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(enroll.manualSecret) }).generate();
    expect((await app.inject({
      method: "POST",
      url: "/api/auth/mfa/enroll/confirm",
      headers: { cookie },
      payload: { ticket: enroll.ticket, code },
    })).statusCode).toBe(200);

    const again = await start("/api/auth/sso/google/start");
    claims(again.nonce, subject);
    const confirm = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${again.state}` });
    expect(confirm.headers.location).toBe("/login?sso=confirm");
    expect(String(confirm.headers["set-cookie"])).not.toContain("cdos_session=");
    const pending = cookieFrom(confirm, "cdos_sso_pending");
    const done = await app.inject({
      method: "POST",
      url: "/api/auth/sso/confirm",
      headers: { cookie: pending },
      payload: { code: enroll.backupCodes[0] },
    });
    expect(done.statusCode).toBe(200);
    expect(String(done.headers["set-cookie"])).toContain("cdos_session=");
  });

  it("links and unlinks after step-up, and will not link the demo shop", async () => {
    const person = await makePerson("teller", "");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "person", password: "correct-horse", tenantId: person.tenantId },
    });
    const cookie = cookieFrom(login, "cdos_session");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
    const begun = await start("/api/auth/sso/link/google/start", cookie);
    const subject = `link-${randomUUID()}`;
    claims(begun.nonce, subject);
    const linked = await app.inject({
      method: "GET",
      url: `/auth/sso/link/callback?code=good&state=${begun.state}`,
      headers: { cookie },
    });
    expect(linked.headers.location).toBe("/app?sso=linked");
    const rows = await handle.db.select().from(schema.staffIdentities).where(eq(schema.staffIdentities.staffUserId, person.userId));
    expect(rows.map((row) => row.subject)).toEqual([subject]);
    const audited = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.identity_linked"));
    expect(JSON.stringify(audited)).not.toContain("hidden@example.com");
    expect(JSON.stringify(audited)).not.toContain("ya29-test-token");

    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
    const removed = await app.inject({ method: "POST", url: "/api/auth/sso/google/unlink", headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(401);

    const demo = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "a.singh", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    const demoCookie = cookieFrom(demo, "cdos_session");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie: demoCookie }, payload: { password: DEMO.password } });
    const demoLink = await app.inject({ method: "GET", url: "/api/auth/sso/link/google/start", headers: { cookie: demoCookie } });
    expect(demoLink.statusCode).toBe(403);
  });

  it("spends the owner pending sign-in after three wrong codes, once", async () => {
    const person = await makePerson("administrator", "");
    const backup = "abcde-fghij";
    await handle.db.insert(schema.staffTotp).values({
      staffUserId: person.userId, tenantId: person.tenantId, secretEnc: "not-used", enrolledAt: new Date(),
    });
    await handle.db.insert(schema.staffRecoveryCodes).values({
      id: `rcv-${randomUUID()}`, tenantId: person.tenantId, staffUserId: person.userId,
      codeHash: await hashPassword(normalizeBackupCode(backup)),
    });
    const token = randomUUID();
    const challengeId = `chl-${randomUUID()}`;
    await handle.db.insert(schema.authChallenges).values({
      id: challengeId, tenantId: person.tenantId, purpose: "oidc_signin",
      challengeHash: createHash("sha256").update(token).digest("hex"),
      provider: "google", issuer: "https://accounts.google.com", subject: "sub",
      staffUserId: person.userId, returnTo: "/app", expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    for (let n = 0; n < 3; n += 1) {
      const result = await confirmOwner(handle.db, token, "wrong-code-1", "203.0.113.44");
      expect(result.ok).toBe(false);
    }
    const row = (await handle.db.select().from(schema.authChallenges).where(eq(schema.authChallenges.id, challengeId)).limit(1))[0];
    expect(row?.usedAt).toBeTruthy();
    const [first, second] = await Promise.all([
      spendPendingChallenge(handle.db, challengeId, person.tenantId),
      spendPendingChallenge(handle.db, challengeId, person.tenantId),
    ]);
    expect(first).toBe(false);
    expect(second).toBe(false);
    const audits = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, person.userId));
    expect(audits.filter((event) => event.action === "auth.login_failed").length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits)).not.toContain("wrong-code-1");
    const code = (await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, person.userId)).limit(1))[0];
    expect(code?.usedAt ?? null).toBeNull();
  });

  it("keeps the miss cap at 3 under a parallel burst", async () => {
    const person = await makePerson("administrator", "");
    await handle.db.insert(schema.staffTotp).values({
      staffUserId: person.userId, tenantId: person.tenantId, secretEnc: "not-used", enrolledAt: new Date(),
    });
    await handle.db.insert(schema.staffRecoveryCodes).values({
      id: `rcv-${randomUUID()}`, tenantId: person.tenantId, staffUserId: person.userId,
      codeHash: await hashPassword(normalizeBackupCode("abcde-fghij")),
    });
    const token = randomUUID();
    const challengeId = `chl-${randomUUID()}`;
    await handle.db.insert(schema.authChallenges).values({
      id: challengeId, tenantId: person.tenantId, purpose: "oidc_signin",
      challengeHash: createHash("sha256").update(token).digest("hex"),
      provider: "google", issuer: "https://accounts.google.com", subject: "sub",
      staffUserId: person.userId, returnTo: "/app", expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => confirmOwner(handle.db, token, "nope", "198.51.100.20")));
    expect(results.every((result) => result.ok === false)).toBe(true);
    const row = (await handle.db.select().from(schema.authChallenges).where(eq(schema.authChallenges.id, challengeId)).limit(1))[0];
    expect(row?.usedAt).toBeTruthy();
    const counted = await handle.db.execute(sql`SELECT failures FROM signin_failures WHERE bucket = ${`sso-pending:${challengeId}`}`);
    expect(Number((counted.rows[0] as { failures: number | string }).failures)).toBe(3);
    const late = await confirmOwner(handle.db, token, "abcde-fghij", "198.51.100.21");
    expect(late.ok).toBe(false);
  });

  it("answers 429 on confirm when the address is locked and audits auth.login_locked", async () => {
    await handle.db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, "factor-ip:127.0.0.1"));
    const owner = await readyOwner(`lock-${randomUUID()}`);
    await handle.db.insert(schema.signinFailures).values({
      bucket: "factor-ip:127.0.0.1", failures: 5, windowStartedAt: new Date(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sso/confirm",
      headers: { cookie: owner.pending },
      payload: { code: "000000" },
    });
    expect(res.statusCode).toBe(429);
    const audits = await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, owner.person.userId));
    expect(audits.some((event) => event.action === "auth.login_locked")).toBe(true);
    await handle.db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, "factor-ip:127.0.0.1"));
  });

  it("refuses the right code after a lock and does not spend it", async () => {
    await handle.db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, "factor-ip:127.0.0.1"));
    const owner = await readyOwner(`after-${randomUUID()}`);
    await handle.db.insert(schema.signinFailures).values({
      bucket: "factor-ip:127.0.0.1", failures: 5, windowStartedAt: new Date(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sso/confirm",
      headers: { cookie: owner.pending },
      payload: { code: owner.backup },
    });
    expect(res.statusCode).toBe(429);
    expect(String(res.headers["set-cookie"] ?? "")).not.toContain("cdos_session=");
    const code = (await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, owner.person.userId)).limit(1))[0];
    expect(code?.usedAt ?? null).toBeNull();
    await handle.db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, "factor-ip:127.0.0.1"));
  });

  it("locks one address without locking another", async () => {
    const person = await makePerson("administrator", "");
    const plain = "abcde-fghij";
    await handle.db.insert(schema.staffTotp).values({
      staffUserId: person.userId, tenantId: person.tenantId, secretEnc: "not-used", enrolledAt: new Date(),
    });
    await handle.db.insert(schema.staffRecoveryCodes).values({
      id: `rcv-${randomUUID()}`, tenantId: person.tenantId, staffUserId: person.userId,
      codeHash: await hashPassword(normalizeBackupCode(plain)),
    });
    const user = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, person.userId)).limit(1))[0];
    if (!user) throw new Error("missing owner");
    await handle.db.insert(schema.signinFailures).values({
      bucket: "factor-ip:203.0.113.8", failures: 5, windowStartedAt: new Date(),
    });
    const locked = await verifyOwnerFactor(handle.db, user, plain, "203.0.113.8");
    expect(locked).toMatchObject({ ok: false, error: "locked" });
    const untouched = (await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, person.userId)).limit(1))[0];
    expect(untouched?.usedAt ?? null).toBeNull();
    const open = await verifyOwnerFactor(handle.db, user, plain, "203.0.113.9");
    expect(open.ok).toBe(true);
  });

  it("refuses a second Google account for the same person", async () => {
    const person = await makePerson("teller", "");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "person", password: "correct-horse", tenantId: person.tenantId },
    });
    const cookie = cookieFrom(login, "cdos_session");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
    const first = await start("/api/auth/sso/link/google/start", cookie);
    const subject = `link-${randomUUID()}`;
    claims(first.nonce, subject);
    const linked = await app.inject({
      method: "GET",
      url: `/auth/sso/link/callback?code=good&state=${first.state}`,
      headers: { cookie },
    });
    expect(linked.headers.location).toBe("/app?sso=linked");
    await app.inject({ method: "POST", url: "/api/auth/stepup", headers: { cookie }, payload: { password: "correct-horse" } });
    const again = await start("/api/auth/sso/link/google/start", cookie);
    claims(again.nonce, `other-${randomUUID()}`);
    const refused = await app.inject({
      method: "GET",
      url: `/auth/sso/link/callback?code=good&state=${again.state}`,
      headers: { cookie },
    });
    expect(refused.statusCode).toBe(303);
    expect(refused.headers.location).toBe("/login?sso=refused");
    const rows = await handle.db.select().from(schema.staffIdentities).where(eq(schema.staffIdentities.staffUserId, person.userId));
    expect(rows.map((row) => row.subject)).toEqual([subject]);
  });

  it("does not count a completed sign-in, and a full address gets a plain page", async () => {
    await handle.db.execute(sql`DELETE FROM signin_failures WHERE bucket LIKE 'sso-ip:%'`);
    const subject = `cap-${randomUUID()}`;
    await makePerson("teller", subject);
    const begun = await start("/api/auth/sso/google/start?returnTo=/app");
    claims(begun.nonce, subject);
    const ok = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${begun.state}` });
    expect(ok.headers.location).toBe("/app");
    const afterOk = await handle.db.execute(sql`SELECT bucket FROM signin_failures WHERE bucket LIKE 'sso-ip:%'`);
    expect(afterOk.rows).toEqual([]);

    const miss = await start("/api/auth/sso/google/start");
    claims(miss.nonce, `missing-${randomUUID()}`);
    const refused = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${miss.state}` });
    expect(refused.headers.location).toBe("/login?sso=refused");
    const counted = await handle.db.execute(sql`SELECT bucket, failures FROM signin_failures WHERE bucket LIKE 'sso-ip:%'`);
    expect(counted.rows).toHaveLength(1);
    const bucket = String((counted.rows[0] as { bucket: string }).bucket);
    expect(Number((counted.rows[0] as { failures: number | string }).failures)).toBe(1);

    const again = await start("/api/auth/sso/google/start?returnTo=/app");
    claims(again.nonce, subject);
    const kept = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${again.state}` });
    expect(kept.headers.location).toBe("/app");
    const held = await handle.db.execute(sql`SELECT failures FROM signin_failures WHERE bucket = ${bucket}`);
    expect(Number((held.rows[0] as { failures: number | string }).failures)).toBe(1);

    await handle.db.execute(sql`UPDATE signin_failures SET failures = ${SIGNIN_IP_MAX} WHERE bucket = ${bucket}`);
    const full = await start("/api/auth/sso/google/start");
    claims(full.nonce, subject);
    const locked = await app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${full.state}` });
    expect(locked.statusCode).toBe(303);
    expect(locked.headers.location).toBe("/login?sso=slow");
    expect(String(locked.headers["content-type"] ?? "")).not.toContain("json");
    expect(locked.body).not.toContain("too_many_attempts");
    await handle.db.execute(sql`DELETE FROM signin_failures WHERE bucket = ${bucket}`);
  });

  it("reads the seeded platform tenant and does not insert one", async () => {
    await handle.db.delete(schema.authChallenges).where(eq(schema.authChallenges.tenantId, "tnt-platform"));
    await handle.db.delete(schema.tenants).where(eq(schema.tenants.id, "tnt-platform"));
    try {
      const before = await handle.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
      const res = await app.inject({ method: "GET", url: "/api/auth/sso/google/start" });
      expect(res.statusCode).toBe(503);
      const after = await handle.db.execute(sql`SELECT count(*)::int AS n FROM tenants`);
      expect(after.rows).toEqual(before.rows);
      const missing = await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-platform"));
      expect(missing).toEqual([]);
    } finally {
      const text = await readFile(new URL("../src/db/migrations/084_platform_tenant.sql", import.meta.url), "utf8");
      await handle.db.execute(sql.raw(text));
      await handle.db.execute(sql.raw(text));
    }
    const seeded = (await handle.db.select().from(schema.tenants).where(eq(schema.tenants.id, "tnt-platform")).limit(1))[0];
    expect(seeded?.plan).toBe("premium");
    expect(seeded?.siteSlug).toBe("platform");
  });

  it("replaces recovery codes only in that shop", async () => {
    const person = await makePerson("administrator", "");
    const other = `tnt-${randomUUID().slice(0, 8)}`;
    const stray = `rcv-${randomUUID()}`;
    await handle.db.insert(schema.staffTotp).values({
      staffUserId: person.userId, tenantId: person.tenantId, secretEnc: "not-used", enrolledAt: new Date(),
    });
    await handle.db.insert(schema.tenants).values({ id: other, name: "Other shop" });
    await handle.db.insert(schema.staffRecoveryCodes).values([
      { id: stray, tenantId: other, staffUserId: person.userId, codeHash: "other-shop" },
      { id: `rcv-${randomUUID()}`, tenantId: person.tenantId, staffUserId: person.userId, codeHash: "this-shop" },
    ]);
    const user = (await handle.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, person.userId)).limit(1))[0];
    if (!user) throw new Error("missing owner");
    const codes = await regenerateRecoveryCodes(handle.db, user);
    expect(codes).toHaveLength(10);
    const left = await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.id, stray));
    expect(left).toHaveLength(1);
    const shop = await handle.db.select().from(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.tenantId, person.tenantId));
    expect(shop).toHaveLength(10);
  });
});
