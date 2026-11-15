/* Sign-up v2.1, PR 3: "Check your inbox" and the enrolment session
   (SIGNUP-LOGIC §3.2, §6, §10; build doc §6, §9.4, §9.5, §10).

   The code goes to the email on file the moment a credential is saved;
   6 digits, 10 minutes, 5 tries, one active, 3 sends per 15 minutes. Only
   the browser that saved a candidate can turn it into the owner's; that
   moves enrolling → verified and issues a 24-hour sliding enrolment
   session scoped to this one reservation. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerCredentialRoutes } from "../src/routes/signup-credential.js";
import { registerSignupEmailRoutes } from "../src/routes/signup-email.js";
import { loadAccount, sha256 } from "../src/onboarding/signup-account.js";
import { ENROLMENT_TTL_MS, enrolmentFor, maskEmail, verifySignupCode } from "../src/onboarding/email-code.js";
import { resetIdDoor } from "../src/routes/onboarding-public.js";
import type { EmailStatus } from "../src/email.js";

let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
const inbox: { to: string; text: string }[] = [];
const mail = async (to: string, _subject: string, body: { text: string }): Promise<EmailStatus> => { inbox.push({ to, text: body.text }); return "simulated"; };
const lastCode = (to: string) => [...inbox].reverse().find((m) => m.to === to)!.text.match(/\b(\d{6})\b/)![1]!;

let n = 0;
async function reserve() {
  n++;
  const id = `enq-${randomUUID()}`;
  const tail = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const cdId = `CD-CODE-${tail[n % 31]}${tail[(n * 7) % 31]}${tail[(n * 11) % 31]}${tail[(n * 13) % 31]}`;
  const email = `code${n}@yorkfx.test`;
  await handle.db.insert(schema.enquiries).values({
    id, reference: `CD-C${String(n).padStart(5, "0")}`, kind: "early_access", email, name: "Daniel Okafor", status: "invited", cdId,
    details: { firstName: "Daniel", lastName: "Okafor", shopName: "Harbour Exchange", phone: "+1 416 555 0142", country: "Canada" },
  });
  return { id, cdId, email };
}
const jarOf = (res: { cookies: { name: string; value: string }[] }, name = "cd_enrol_attempt"): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === name);
  return c ? { [name]: c.value } : {};
};
const post = (url: string, payload: unknown, cookies: Record<string, string> = {}, ip = "198.51.100.30") =>
  app.inject({ method: "POST", url, payload: payload as object, cookies, remoteAddress: ip });
const PW = { password: "four plain words here", confirm: "four plain words here" };
async function withPassword(cdId: string, ip?: string) {
  const res = await post(`/api/onboarding/${cdId}/password`, PW, {}, ip);
  expect(res.statusCode, res.body).toBe(200);
  return { res, jar: jarOf(res) };
}

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handle = await createDb();
  app = Fastify();
  await app.register(cookie);
  door = createIdDoor({ db: handle.db, logRefusal: () => {} });
  registerCredentialRoutes(app, handle.db, door, { breachRange: async () => "00000000000000000000000000000000000:0", mail });
  registerSignupEmailRoutes(app, handle.db, door, { mail });
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => { door.reset(); });

describe("the code is sent the moment a credential is saved", () => {
  it("goes to the email on file, 6 digits, and the response says nothing of the email", async () => {
    const { cdId, email } = await reserve();
    const { res } = await withPassword(cdId);
    expect(res.json()).toEqual({ ok: true, kind: "password", state: "enrolling", codeSent: true });
    expect(res.body).not.toContain(email);
    expect(lastCode(email)).toMatch(/^\d{6}$/);
    const account = (await handle.db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, (await door.findByCdId(cdId))!.id)))[0]!;
    expect(account.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(account.codeHash).not.toContain(lastCode(email));
  });

  it("sends at most 3 in 15 minutes, counting the first", async () => {
    const { cdId, jar } = await (async () => { const r = await reserve(); return { ...r, ...(await withPassword(r.cdId)) }; })();
    expect((await post(`/api/onboarding/${cdId}/email/send`, {}, jar)).statusCode).toBe(200);
    expect((await post(`/api/onboarding/${cdId}/email/send`, {}, jar)).statusCode).toBe(200);
    const fourth = await post(`/api/onboarding/${cdId}/email/send`, {}, jar);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().retryInSeconds).toBeGreaterThan(0);
  });

  it("a resend replaces the last code: only the newest works", async () => {
    const { cdId, email } = await reserve();
    const { jar } = await withPassword(cdId);
    const first = lastCode(email);
    await post(`/api/onboarding/${cdId}/email/send`, {}, jar);
    const second = lastCode(email);
    if (first !== second) expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: first }, jar)).statusCode).toBe(401);
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: second }, jar)).statusCode).toBe(200);
  });
});

describe("entering it", () => {
  it("verifies this browser's credential, drops the others, moves to verified and issues the session", async () => {
    const { id, cdId, email } = await reserve();
    const other = await withPassword(cdId, "203.0.113.5");
    const mine = await withPassword(cdId);
    const code = lastCode(email);
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code }, {})).statusCode).toBe(400);
    const res = await post(`/api/onboarding/${cdId}/email/verify`, { code }, mine.jar);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: "verified", you: { name: "Daniel Okafor", email: maskEmail(email), mobile: "••• 0142", country: "Canada" } });
    expect(res.body).not.toContain(email);
    const session = res.cookies.find((c) => c.name === "cd_enrol")!;
    expect(session.httpOnly).toBe(true);
    expect(session.path).toBe("/api/onboarding");
    const creds = await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, id));
    expect(creds).toHaveLength(1);
    expect(creds[0]!.verifiedAt).not.toBeNull();
    expect(creds[0]!.attemptHash).toBe(sha256(mine.jar.cd_enrol_attempt!));
    expect((await loadAccount(handle.db, id))).toMatchObject({ state: "verified" });
    expect((await loadAccount(handle.db, id)).emailVerifiedAt).not.toBeNull();
    /* the other browser's candidate is gone, and the code is spent */
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code }, other.jar)).statusCode).toBe(409);
    expect((await post(`/api/onboarding/${cdId}/password`, PW, mine.jar)).json().error).toBe("already_verified");
  });

  it("401 on a wrong code, 423 on the fifth, and the code is then burnt", async () => {
    const { cdId, email } = await reserve();
    const { jar } = await withPassword(cdId);
    const right = lastCode(email);
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: wrong }, jar)).statusCode).toBe(401);
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: wrong }, jar)).statusCode).toBe(423);
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: right }, jar)).statusCode).not.toBe(200);
    await post(`/api/onboarding/${cdId}/email/send`, {}, jar);
    expect((await post(`/api/onboarding/${cdId}/email/verify`, { code: lastCode(email) }, jar)).statusCode).toBe(200);
  });

  it("410 once 10 minutes have passed", async () => {
    const { id, cdId, email } = await reserve();
    const { jar } = await withPassword(cdId);
    const r = await verifySignupCode(handle.db, id, sha256(jar.cd_enrol_attempt!), lastCode(email), Date.now() + 10 * 60 * 1000 + 1);
    expect(r).toEqual({ ok: false, status: 410, error: "expired" });
  });

  it("two right answers at once: exactly one wins", async () => {
    const { id, cdId, email } = await reserve();
    const { jar } = await withPassword(cdId);
    const code = lastCode(email);
    const attempt = sha256(jar.cd_enrol_attempt!);
    const results = await Promise.all([verifySignupCode(handle.db, id, attempt, code), verifySignupCode(handle.db, id, attempt, code)]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(await handle.db.select().from(schema.enrolmentSessions).where(eq(schema.enrolmentSessions.enquiryId, id))).toHaveLength(1);
  });
});

describe("the enrolment session", () => {
  async function verified() {
    const r = await reserve();
    const { jar } = await withPassword(r.cdId);
    const res = await post(`/api/onboarding/${r.cdId}/email/verify`, { code: lastCode(r.email) }, jar);
    return { ...r, session: jarOf(res, "cd_enrol") };
  }
  const reqWith = (cookies: Record<string, string>) => ({ cookies } as never);
  const replyStub = () => ({ setCookie: () => {} } as never);

  it("is for this reservation only, and slides 24 hours on use", async () => {
    const a = await verified();
    const b = await reserve();
    expect(await enrolmentFor(handle.db, reqWith(a.session), replyStub(), a.id)).toEqual({ enquiryId: a.id });
    expect(await enrolmentFor(handle.db, reqWith(a.session), replyStub(), b.id)).toBeNull();
    const later = Date.now() + ENROLMENT_TTL_MS - 1000;
    expect(await enrolmentFor(handle.db, reqWith(a.session), replyStub(), a.id, later)).not.toBeNull();
    const row = (await handle.db.select().from(schema.enrolmentSessions).where(eq(schema.enrolmentSessions.enquiryId, a.id)))[0]!;
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + ENROLMENT_TTL_MS);
  });

  it("lapses after 24 idle hours, and a stored token is only its hash", async () => {
    const a = await verified();
    const row = (await handle.db.select().from(schema.enrolmentSessions).where(eq(schema.enrolmentSessions.enquiryId, a.id)))[0]!;
    expect(row.tokenHash).toBe(sha256(a.session.cd_enrol!));
    expect(await enrolmentFor(handle.db, reqWith(a.session), replyStub(), a.id, row.expiresAt.getTime() + 1)).toBeNull();
    expect(await enrolmentFor(handle.db, reqWith({ cd_enrol: randomBytes(32).toString("base64url") }), replyStub(), a.id)).toBeNull();
  });
});

describe("GET state, before and after the code", () => {
  it("shows the owner's details only with this reservation's enrolment session", async () => {
    const full = await buildApp(handle.db);
    resetIdDoor();
    const { id, cdId } = await reserve();
    const token = randomBytes(32).toString("base64url");
    await loadAccount(handle.db, id);
    await handle.db.update(schema.signupAccounts).set({ state: "verified", lastStep: "08-shop-name" }).where(eq(schema.signupAccounts.enquiryId, id));
    await handle.db.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId: id, expiresAt: new Date(Date.now() + 60_000) });
    const bare = await full.inject({ method: "GET", url: `/api/onboarding/${cdId}/state` });
    expect(bare.json()).toEqual({ valid: true, operatingName: "Harbour Exchange", state: "reserved" });
    const enrolled = await full.inject({ method: "GET", url: `/api/onboarding/${cdId}/state`, cookies: { cd_enrol: token } });
    expect(enrolled.json()).toMatchObject({ signup: "verified", lastStep: "08-shop-name", you: { name: "Daniel Okafor", country: "Canada" } });
    const stranger = await reserve();
    expect(Object.keys((await full.inject({ method: "GET", url: `/api/onboarding/${stranger.cdId}/state`, cookies: { cd_enrol: token } })).json()).sort()).toEqual(["operatingName", "state", "valid"]);
    await full.close();
  });
});
