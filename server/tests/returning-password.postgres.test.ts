import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { DEMO, seed } from "../src/seed.js";
import { hashPassword, hashSignupSecret } from "../src/auth/password.js";
import { forget } from "../src/cooldown.js";
import * as mailer from "../src/email.js";
import * as hashes from "../src/auth/password.js";
import { judgeSignIn } from "../src/auth/signin-guard.js";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";

const url = process.env.TEST_DATABASE_URL;
const PASS = "four returning words here";
const EMAIL = "returning@example.test";
const CDID = "CD-RETN-7K42";
const OWNER = `${DEMO.tenantId}:${EMAIL}`;
const ENQUIRY = "enq-returning-password";
const cookie = (r: { cookies: { name: string; value: string }[] }, name: string) => r.cookies.find(c => c.name === name)?.value;

describe.skipIf(!url)("returning password contract on PostgreSQL", () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let stored: string;
  let mail: MockInstance<typeof mailer.sendEmail>;
  const inbox: string[] = [];
  const post = (path: string, payload: object, ip = "203.0.113.221") => app.inject({ method: "POST", url: `/api/auth/login${path}`, payload, remoteAddress: ip });
  const password = (identifier = EMAIL, secret = PASS, ip?: string) => post("/password", { identifier, password: secret }, ip);

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", url!); // suite skipped without this disposable URL
    vi.stubEnv("SEED_PASSWORD", "yorkville");
    handle = await createDb();
    await seed(handle.db);
    stored = await hashSignupSecret(PASS);
    await handle.db.insert(schema.enquiries).values({ id: ENQUIRY, reference: "CD-RETURN", kind: "early_access", email: EMAIL, cdId: CDID, status: "accepted", tenantId: DEMO.tenantId });
    await handle.db.insert(schema.signupAccounts).values({ enquiryId: ENQUIRY, accountId: "returning-account", state: "active", emailVerifiedAt: new Date() });
    await handle.db.insert(schema.signupCredentials).values({ id: "returning-credential", enquiryId: ENQUIRY, kind: "password", attemptHash: "synthetic-attempt", passwordHash: stored, verifiedAt: new Date() });
    await handle.db.insert(schema.onboarding).values({ enquiryId: ENQUIRY, tenantId: DEMO.tenantId });
    await handle.db.insert(schema.staffUsers).values({ id: OWNER, staffId: EMAIL, cdId: CDID, name: "Private Owner", tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId, role: "administrator", passwordHash: stored });
    app = await buildApp(handle.db);
    mail = vi.spyOn(mailer, "sendEmail").mockImplementation(async (_to, _subject, body) => { inbox.push(body.text); return "sent"; });
  });
  afterAll(async () => { await app?.close(); await handle?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  beforeEach(async () => {
    forget(); inbox.length = 0; mail.mockClear();
    await handle.db.execute(sql`DELETE FROM signin_failures`);
    await handle.db.update(schema.signupAccounts).set({ state: "active", emailVerifiedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, ENQUIRY));
    await handle.db.update(schema.signupCredentials).set({ verifiedAt: new Date() }).where(eq(schema.signupCredentials.id, "returning-credential"));
    await handle.db.update(schema.staffUsers).set({ active: true, passwordHash: stored }).where(eq(schema.staffUsers.id, OWNER));
    await handle.db.update(schema.tenants).set({ suspended: false }).where(eq(schema.tenants.id, DEMO.tenantId));
    await handle.db.update(schema.onboarding).set({ tenantId: DEMO.tenantId }).where(eq(schema.onboarding.enquiryId, ENQUIRY));
  });

  it("preserves raw legacy usernames and numeric IDs, without treating contact email as ownership", async () => {
    const id = `${DEMO.tenantId}:legacy-returning`;
    await handle.db.insert(schema.staffUsers).values({ id, staffId: "RETN7K42", cdId: "CD-RETN-0042", email: "contact-only@example.test", name: "Legacy", tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId, role: "teller", passwordHash: await hashPassword(PASS) });
    for (const identifier of ["RETN7K42", "cd-retn-0042"]) {
      const r = await password(identifier);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ next: "authenticated", needsCode: false });
      expect(cookie(r, "cdos_session")).toBeTruthy();
      expect(r.json().user.id).toBe("RETN7K42");
    }
    expect((await password("contact-only@example.test")).statusCode).toBe(401);
    for (let n = 1; n <= 10; n++) {
      const r = await password(n % 2 ? "RETN7K42" : "CD-RETN-0042", "wrong", `192.0.2.${n}`);
      expect(r.statusCode).toBe(n === 10 ? 429 : 401);
    }
    expect((await post("", { staffId: "RETN7K42", password: PASS }, "192.0.2.101")).statusCode).toBe(429);
    expect(mail).not.toHaveBeenCalled();
  });

  it("does not give an unverified or no-email signup subject a legacy password-only session", async () => {
    await handle.db.update(schema.signupAccounts).set({ emailVerifiedAt: null }).where(eq(schema.signupAccounts.enquiryId, ENQUIRY));
    const unverified = await password();
    expect(unverified.statusCode).toBe(401); expect(unverified.cookies).toHaveLength(0);
    await handle.db.update(schema.signupAccounts).set({ emailVerifiedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, ENQUIRY));
    await handle.db.update(schema.staffUsers).set({ staffId: "signup-without-email" }).where(eq(schema.staffUsers.id, OWNER));
    try {
      for (const id of [CDID, "signup-without-email"]) {
        const r = await password(id);
        expect(r.statusCode).toBe(401); expect(r.cookies).toHaveLength(0);
      }
    } finally { await handle.db.update(schema.staffUsers).set({ staffId: EMAIL }).where(eq(schema.staffUsers.id, OWNER)); }
    expect(mail).not.toHaveBeenCalled();
  });

  it("records refusal reason codes without raw identifiers, email or password", async () => {
    await password(CDID, "private-wrong-secret");
    await password("never-known@example.test", "private-wrong-secret");
    const rows = await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, "auth.login_failed"), sql`${schema.auditEvents.at} > now() - interval '1 minute'`));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.detail).toMatchObject({ reason: "invalid_credentials" });
      // actorId remains the authoritative database identity for the existing
      // per-person audit view. The attempted spelling and secret never enter detail.
      expect(JSON.stringify(row.detail)).not.toMatch(/returning@example|never-known@example|private-wrong-secret|CD-RETN|contact-only@example/);
    }
  });

  it("starts known/unknown/email/legacy identifiers without personal data or cookies", async () => {
    for (const identifier of [EMAIL, "unknown@example.test", "a.singh", "maryjane", CDID, "CD-NONE-7K42"]) {
      const r = await post("/start", { identifier });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ next: "password" });
      expect(Object.keys(r.json()).every(k => ["next", "shopName"].includes(k))).toBe(true);
      if (identifier.includes("@")) expect(r.json()).toEqual({ next: "password" });
      expect(r.body).not.toMatch(/Private Owner|returning@example|legalEntity|tenantId|user/);
      expect(r.cookies).toHaveLength(0);
    }
    expect(mail).not.toHaveBeenCalled();
  });

  it("strictly rejects mixed shapes, blank, oversized and non-string input", async () => {
    for (const payload of [{ identifier: " " }, { identifier: 4 }, { identifier: "a".repeat(255) }, { identifier: EMAIL, staffId: EMAIL, password: PASS }, { identifier: EMAIL, tenantId: DEMO.tenantId }]) {
      expect((await post("/start", payload)).statusCode).toBe(400);
    }
    for (const payload of [{ identifier: EMAIL }, { identifier: EMAIL, password: PASS, trustDevice: true }, { identifier: EMAIL, password: {} }]) {
      expect((await post("/password", payload)).statusCode).toBe(400);
    }
  });

  it("returns a client error for malformed JSON, without echoing its contents", async () => {
    for (const path of ["/start", "/password"]) {
      const r = await app.inject({ method: "POST", url: `/api/auth/login${path}`, headers: { "content-type": "application/json" }, payload: '{"identifier":"private-broken-email' });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("canonical ID and email require the real code before a 12-hour session", async () => {
    for (const identifier of [CDID.toLowerCase(), EMAIL.toUpperCase()]) {
      forget();
      const r = await password(identifier);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ next: "code", needsCode: true });
      expect(cookie(r, "cdos_session")).toBeUndefined();
      expect(mail.mock.calls.at(-1)?.[2].sensitive).toBe(true);
      const proof = cookie(r, "cdos_login_proof");
      const code = inbox.at(-1)?.match(/\b\d{6}\b/)?.[0];
      if (!proof || !code) throw new Error("fixture did not receive a proof and code");
      const verified = await app.inject({ method: "POST", url: "/api/auth/login/verify", payload: { staffId: identifier, code }, cookies: { cdos_login_proof: proof } });
      expect(verified.statusCode, verified.body).toBe(200);
      const token = cookie(verified, "cdos_session");
      if (!token) throw new Error("no real session");
      const me = await app.inject({ method: "GET", url: "/api/auth/me", cookies: { cdos_session: token } });
      expect(me.json().user).toMatchObject({ id: EMAIL, tenantId: DEMO.tenantId });
      const expiry = verified.cookies.find(c => c.name === "cdos_session")?.expires;
      expect(new Date(expiry!).getTime() - Date.now()).toBeGreaterThan(11.99 * 3600000);
      expect(new Date(expiry!).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600000);
    }
  });

  it("refuses unknown, wrong, candidate-only, inactive and foreign provisioning identically", async () => {
    const wrong = await password(EMAIL, "wrong");
    expect(wrong.statusCode).toBe(401);
    expect((await password("unknown@example.test", "wrong")).json()).toEqual(wrong.json());
    await handle.db.update(schema.signupCredentials).set({ verifiedAt: null }).where(eq(schema.signupCredentials.id, "returning-credential"));
    expect((await password()).statusCode).toBe(401);
    await handle.db.update(schema.signupCredentials).set({ verifiedAt: new Date() }).where(eq(schema.signupCredentials.id, "returning-credential"));
    for (const state of ["reserved", "enrolling", "verified"] as const) {
      await handle.db.update(schema.signupAccounts).set({ state }).where(eq(schema.signupAccounts.enquiryId, ENQUIRY));
      expect((await password()).statusCode).toBe(401);
    }
    await handle.db.update(schema.signupAccounts).set({ state: "active" }).where(eq(schema.signupAccounts.enquiryId, ENQUIRY));
    await handle.db.update(schema.onboarding).set({ tenantId: "foreign-tenant" }).where(eq(schema.onboarding.enquiryId, ENQUIRY));
    expect((await password()).statusCode).toBe(401);
    expect(mail).not.toHaveBeenCalled();
  });

  it("locks on the tenth miss across ID/email and all three password doors", async () => {
    for (let n = 1; n <= 10; n++) {
      const identifier = n % 2 ? CDID : EMAIL;
      const r = n % 3 === 0 ? await post("", { staffId: identifier, password: "wrong" }, `203.0.113.${n}`)
        : n % 3 === 1 ? await post("/start", { staffId: identifier, password: "wrong" }, `203.0.113.${n}`)
        : await password(identifier, "wrong", `203.0.113.${n}`);
      expect(r.statusCode, `miss ${n}: ${r.body}`).toBe(n === 10 ? 429 : 401);
    }
    const correct = await password(EMAIL, PASS, "203.0.113.99");
    expect(correct.statusCode).toBe(429);
    expect(cookie(correct, "cdos_session")).toBeUndefined();
    expect(mail).not.toHaveBeenCalled();
    await app.close(); await handle.close();
    handle = await createDb(); app = await buildApp(handle.db);
    expect((await password(CDID, PASS, "203.0.113.98")).statusCode).toBe(429);
    await handle.db.execute(sql`UPDATE signin_failures SET window_started_at = now() - interval '16 minutes'`);
    expect((await password()).statusCode).toBe(200);
  });

  it("locks one connection on its tenth different unknown identifier", async () => {
    for (let n = 1; n <= 10; n++) expect((await password(`unknown-${n}@example.test`, "wrong")).statusCode).toBe(n === 10 ? 429 : 401);
    expect((await password()).statusCode).toBe(429);
  });

  it("uses the current staff hash after a password change, never the enrolment copy", async () => {
    await handle.db.update(schema.staffUsers).set({ passwordHash: await hashPassword("replacement words") }).where(eq(schema.staffUsers.id, OWNER));
    expect((await password()).statusCode).toBe(401);
    expect((await password(EMAIL, "replacement words")).statusCode).toBe(200);
  });

  it("refuses a suspended user or tenant and creates no proof", async () => {
    await handle.db.update(schema.staffUsers).set({ active: false }).where(eq(schema.staffUsers.id, OWNER));
    expect((await password()).statusCode).toBe(401);
    await handle.db.update(schema.staffUsers).set({ active: true }).where(eq(schema.staffUsers.id, OWNER));
    await handle.db.update(schema.tenants).set({ suspended: true }).where(eq(schema.tenants.id, DEMO.tenantId));
    expect((await password()).statusCode).toBe(403);
    expect(mail).not.toHaveBeenCalled();
  });

  it("a mail failure returns unavailable without a proof or session", async () => {
    mail.mockResolvedValueOnce("failed");
    const r = await password();
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("email_unavailable");
    expect(r.cookies).toHaveLength(0);
    expect((await handle.db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.userId, OWNER)))).toHaveLength(0);
  });

  it("a late correct password cannot reopen a connection another request locked", async () => {
    let release: (value: boolean) => void = () => { throw new Error("not waiting"); };
    let started: () => void = () => { throw new Error("not started"); };
    const waiting = new Promise<void>(r => { started = r; });
    const verify = vi.spyOn(hashes, "verifyPassword").mockImplementationOnce(async () => {
      started(); return new Promise<boolean>(r => { release = r; });
    });
    const first = judgeSignIn(handle.db, { password: PASS, storedHash: stored, accountKey: "acct:late", ip: "192.0.2.221", eligible: true });
    try {
      await waiting;
      for (let n = 0; n < 9; n++) {
        const r = await judgeSignIn(handle.db, { password: "wrong", storedHash: null, accountKey: `miss:late:${n}`, ip: "192.0.2.221", eligible: false });
        expect(r.result).toBe(n === 8 ? "locked" : "fail");
      }
      release(true); await first;
      const again = await judgeSignIn(handle.db, { password: PASS, storedHash: stored, accountKey: "acct:after-late", ip: "192.0.2.221", eligible: true });
      expect(again.result).toBe("locked");
    } finally { release(true); await first; verify.mockRestore(); }
  });

  it("gives known and unknown starts equivalent ordinary and blocked-database timing", async () => {
    let sampleNo = 0;
    const sample = async (id: string) => {
      const began = performance.now(); const r = await post("/start", { identifier: id }, `192.0.2.${++sampleNo}`);
      expect(r.statusCode).toBe(200);
      return { elapsed: performance.now() - began, r };
    };
    for (const [knownId, unknownId] of [[EMAIL, "absent@example.test"], [CDID, "CD-NONE-7K42"]] as const) {
      const known: number[] = [], unknown: number[] = [];
      for (let n = 0; n < 5; n++) {
        known.push((await sample(knownId)).elapsed); unknown.push((await sample(unknownId)).elapsed);
      }
      const median = (xs: number[]) => xs.sort((a,b) => a-b)[2]!;
      expect(Math.abs(median(known) - median(unknown))).toBeLessThan(35);
      expect(Math.min(...known, ...unknown)).toBeGreaterThan(140);
    }
    const pool = new pg.Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      await client.query("BEGIN"); await client.query("LOCK TABLE staff_users IN ACCESS EXCLUSIVE MODE");
      const a = sample(CDID), b = sample("CD-NONE-7K42");
      await delay(260); await client.query("COMMIT");
      const [ka, kb] = await Promise.all([a,b]);
      expect(ka.r.statusCode).toBe(200); expect(kb.r.json()).toEqual({ next: "password" });
      expect(Math.min(ka.elapsed, kb.elapsed)).toBeGreaterThan(250);
      expect(Math.abs(ka.elapsed - kb.elapsed)).toBeLessThan(50);
    } finally { await client.query("ROLLBACK"); client.release(); await pool.end(); }
  });

  it("performs both hash algorithms for ordinary and delayed known/unknown refusals", async () => {
    const verify = vi.spyOn(hashes, "verifyPassword");
    try {
      for (const id of [EMAIL, "absent@example.test", "m.costa"]) {
        verify.mockClear();
        expect((await password(id, "wrong")).statusCode).toBe(401);
        expect(verify).toHaveBeenCalledTimes(2);
        expect(verify.mock.calls.some(c => c[1].startsWith("$argon2id$"))).toBe(true);
        expect(verify.mock.calls.some(c => c[1].startsWith("scrypt$"))).toBe(true);
      }
      verify.mockImplementation(async () => { await delay(110); return false; });
      const elapsed: number[] = [];
      for (const id of [EMAIL, "absent@example.test"]) {
        const began = performance.now(); const r = await password(id, "wrong");
        elapsed.push(performance.now() - began);
        expect(r.statusCode).toBe(401); expect(r.cookies).toHaveLength(0);
      }
      expect(Math.min(...elapsed)).toBeGreaterThan(210);
      expect(Math.abs(elapsed[0]! - elapsed[1]!)).toBeLessThan(60);
    } finally { verify.mockRestore(); }
  });

  it("fails closed on slow/failing hash and database without leaking parameters", async () => {
    const verify = vi.spyOn(hashes, "verifyPassword").mockImplementation(async () => { await delay(30); throw new Error(`private hash ${EMAIL} ${PASS}`); });
    try {
      for (const id of [EMAIL, "absent@example.test"]) {
        const r = await password(id);
        expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: "temporarily_unavailable" });
        expect(r.cookies).toHaveLength(0);
      }
    } finally { verify.mockRestore(); }
    await handle.close();
    try {
      for (const id of [EMAIL, "absent@example.test"]) {
        const began = performance.now(); const r = await post("/start", { identifier: id });
        expect(r.statusCode).toBe(503); expect(r.json()).toEqual({ error: "temporarily_unavailable" });
        expect(performance.now() - began).toBeGreaterThan(140);
      }
    } finally { await app.close(); handle = await createDb(); app = await buildApp(handle.db); }
  });
  it("review R1 refuses v2-shaped usernames at creation and availability", async () => {
    const signed = await post("", { staffId:"r.haddad", password:"yorkville" });
    expect(signed.statusCode).toBe(200);
    const session = cookie(signed, "cdos_session")!; // successful real login above
    try {
      const created = await app.inject({ method:"POST", url:"/api/staff", cookies:{ cdos_session:session },
        payload:{ staffId:CDID.toLowerCase(), name:"Synthetic Collision", role:"teller", password:"other password" } });
      expect(created.statusCode).toBe(400);
      const available = await app.inject({ method:"GET", url:`/api/staff/username?check=${CDID.toLowerCase()}`, cookies:{ cdos_session:session } });
      expect(available.json().check.available).toBe(false);
    } finally { await handle.db.delete(schema.staffUsers).where(eq(schema.staffUsers.staffId, CDID.toLowerCase())); }
  });

  it("review R1 fails closed for existing cross-tenant canonical-ID collisions on every door", async () => {
    const tenantId = "tnt-returning-collision", legalEntityId = "le-returning-collision", branchId = "br-returning-collision";
    await handle.db.insert(schema.tenants).values({ id:tenantId, name:"Other Synthetic Desk" }).onConflictDoNothing();
    await handle.db.insert(schema.legalEntities).values({ id:legalEntityId, tenantId, name:"Other Entity" }).onConflictDoNothing();
    await handle.db.insert(schema.branches).values({ id:branchId, tenantId, legalEntityId, name:"Other Branch" }).onConflictDoNothing();
    const id = `${tenantId}:collision`;
    await handle.db.insert(schema.staffUsers).values({ id, tenantId, legalEntityId, branchId, staffId:CDID.toLowerCase(), name:"Collision", role:"teller", passwordHash:await hashPassword("other password") });
    try {
      for (const secret of [PASS, "other password"]) for (const route of ["", "/start", "/password"]) {
        const r = await post(route, route === "/password" ? { identifier:CDID, password:secret } : { staffId:CDID, password:secret });
        expect(r.statusCode, `${route}: ${r.body}`).toBe(401);
        expect(r.cookies).toHaveLength(0);
      }
      expect((await post("/start", { identifier:CDID })).json()).toEqual({ next:"password" });
      expect(mail).not.toHaveBeenCalled();
    } finally {
      await handle.db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await handle.db.delete(schema.staffUsers).where(eq(schema.staffUsers.id, id));
    }
  });

  it("review F1 bounds only missed ID starts per connection and per ID across restart", async () => {
    for (let n = 0; n < 10; n++) expect((await post("/start", { identifier:`CD-NONE-7K4${"23456789AB"[n]}` })).statusCode).toBe(n === 9 ? 429 : 200);
    for (const identifier of [CDID, "CD-NONE-7K42"]) {
      const began = performance.now();
      const r = await post("/start", { identifier });
      expect(performance.now() - began).toBeGreaterThan(140);
      expect(r.statusCode).toBe(429); expect(r.json()).not.toHaveProperty("shopName"); expect(r.cookies).toHaveLength(0);
    }
    await handle.db.execute(sql`DELETE FROM signin_failures`);
    for (let n = 0; n < 9; n++) expect((await post("/start", { identifier:n % 2 ? "cd-none-7k42" : "CD-NONE-7K42" }, `192.0.2.${n + 1}`)).statusCode).toBe(200);
    await app.close(); await handle.close(); handle = await createDb(); app = await buildApp(handle.db);
    expect((await post("/start", { identifier:"CD-NONE-7K42" }, "192.0.2.100")).statusCode).toBe(429);
    await handle.db.execute(sql`UPDATE signin_failures SET window_started_at = now() - interval '16 minutes'`);
    expect((await post("/start", { identifier:CDID })).statusCode).toBe(200);
  });

  it("review F1 atomically bounds concurrent missed identifier starts", async () => {
    const results = await Promise.all(Array.from({ length:20 }, (_, n) => post("/start", { identifier:`CD-MISS-${1000 + n}` })));
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(9);
    expect(results.filter(r => r.statusCode === 429)).toHaveLength(11);
    for (const r of results.filter(r => r.statusCode === 429)) expect(r.json()).not.toHaveProperty("shopName");
    const buckets = await handle.db.select().from(schema.signinFailures);
    expect(buckets.filter(r => r.bucket.startsWith("start:id:"))).toHaveLength(10);
    expect(buckets.find(r => r.bucket.startsWith("start:ip:"))!.failures).toBeLessThanOrEqual(11);
  });

  it("review F1 permits repeated confirmed IDs without consuming miss buckets", async () => {
    for (let n = 0; n < 12; n++) {
      const r = await post("/start", { identifier:CDID });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ next:"password", shopName:expect.any(String) });
    }
    expect(await handle.db.select().from(schema.signinFailures)).toHaveLength(0);
  });

  it("review F1 refuses locked connections before lookup without creating or growing ID buckets", async () => {
    for (let n = 0; n < 10; n++) await post("/start", { identifier:`CD-MISS-${1000 + n}` });
    const before = await handle.db.select().from(schema.signinFailures).orderBy(schema.signinFailures.bucket);
    // A blocked request must not reach the shop lookup (which this lock stalls).
    const blocker = new pg.Client({ connectionString:url }); await blocker.connect();
    await blocker.query("BEGIN"); await blocker.query("LOCK TABLE staff_users IN ACCESS EXCLUSIVE MODE");
    try {
      for (let n = 0; n < 12; n++) {
        const r = await Promise.race([
          post("/start", { identifier:n % 2 ? CDID : `CD-NEWX-${2000 + n}` }),
          delay(700).then(() => { throw new Error("locked start reached blocked staff lookup"); }),
        ]);
        expect(r.statusCode).toBe(429); expect(r.json()).not.toHaveProperty("shopName");
      }
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
    const after = await handle.db.select().from(schema.signinFailures).orderBy(schema.signinFailures.bucket);
    expect(after).toEqual(before);
    const fresh = await post("/start", { identifier:CDID }, "192.0.2.201");
    expect(fresh.statusCode).toBe(200); expect(fresh.json()).toHaveProperty("shopName");
  });

  it("review R3 refuses already-over-limit attempts without either expensive hash", async () => {
    for (let n = 0; n < 10; n++) await password(EMAIL, "wrong");
    const verify = vi.spyOn(hashes, "verifyPassword");
    try {
      for (const identifier of [EMAIL, "unknown@example.test"]) expect((await password(identifier)).statusCode).toBe(429);
      expect(verify).not.toHaveBeenCalled();
    } finally { verify.mockRestore(); }
  });

  it("review R4 preserves known-person audit attribution without unknown platform-feed spam", async () => {
    const before = await handle.db.select({ id:schema.auditEvents.id }).from(schema.auditEvents);
    await password("never-known-review@example.test", "private-wrong-secret");
    expect(await handle.db.select({ id:schema.auditEvents.id }).from(schema.auditEvents)).toHaveLength(before.length);
    await password(EMAIL, "private-wrong-secret");
    const own = await handle.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.actorId, OWNER), eq(schema.auditEvents.action, "auth.login_failed")));
    expect(own.length).toBeGreaterThan(0);
    expect(own.at(-1)?.detail).toMatchObject({ reason:"invalid_credentials" });
    expect(JSON.stringify(own.at(-1)?.detail)).not.toMatch(/returning@example|private-wrong-secret/);
  });

  it("review R5 removes the successfully released zero connection row", async () => {
    expect((await password("m.costa", "yorkville")).statusCode).toBe(200);
    const rows = await handle.db.select().from(schema.signinFailures).where(eq(schema.signinFailures.bucket, "ip:203.0.113.221"));
    expect(rows).toHaveLength(0);
  });

});
