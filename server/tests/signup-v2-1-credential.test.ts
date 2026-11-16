/* Sign-up v2.1, PR 2: "How will you sign in?" (SIGNUP-LOGIC §3.1, §10;
   build doc §6 Chapter 1, §9.4, §10 server tests).

   A software authenticator makes a real "none" attestation, and a fake
   OIDC provider signs real RS256 ID tokens, so the server's checks run for
   real with no network. The breach range is mocked. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as signData } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { createIdDoor } from "../src/onboarding/cd-id-door.js";
import { registerCredentialRoutes } from "../src/routes/signup-credential.js";
import { advance, allowedFrom, loadAccount } from "../src/onboarding/signup-account.js";
import { checkPassword, isBreached, lengthOf } from "../src/onboarding/password-rule.js";
import { clearJwksCache, sameEmail, type FetchJson } from "../src/onboarding/sso.js";
import { verifyPassword } from "../src/auth/password.js";

const ORIGIN = "https://www.currencydeskos.test";
const RP_ID = "currencydeskos.test";
const ENV = {
  WEBAUTHN_RP_ID: RP_ID, WEBAUTHN_ORIGINS: ORIGIN,
  GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret",
  MICROSOFT_CLIENT_ID: "ms-client", MICROSOFT_CLIENT_SECRET: "ms-secret",
  SSO_REDIRECT_URI: `${ORIGIN}/onboarding/sso`,
} as NodeJS.ProcessEnv;

let handle: DbHandle;
let app: FastifyInstance;
let door: ReturnType<typeof createIdDoor>;
let breached = new Set<string>();
let rangeDown = false;
let idToken: (claims: Record<string, unknown>) => string;
let nextClaims: Record<string, unknown> = {};
let jwks: unknown;

/* ---- the fake provider ---------------------------------------------- */
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
idToken = (claims) => {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${signData("RSA-SHA256", Buffer.from(`${h}.${p}`), rsa.privateKey).toString("base64url")}`;
};
jwks = { keys: [jwk] };
const http: FetchJson = async (url, init) => {
  if (url.includes("certs") || url.includes("keys")) return jwks;
  if (init.method === "POST") return { id_token: idToken(nextClaims) };
  throw new Error(`unexpected ${url}`);
};

/* ---- a software authenticator ---------------------------------------- */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
}
function makePasskey(challenge: string, o: { origin?: string; rpId?: string; uv?: boolean } = {}) {
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = ec.publicKey.export({ format: "jwk" });
  const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(pub.x!, "base64url")], [-3, Buffer.from(pub.y!, "base64url")]]);
  const credId = randomBytes(16);
  const flags = 0x01 | (o.uv === false ? 0 : 0x04) | 0x40;
  const authData = Buffer.concat([
    createHash("sha256").update(o.rpId ?? RP_ID).digest(), Buffer.from([flags]), Buffer.alloc(4),
    Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cbor(cose),
  ]);
  const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
  return {
    id: credId.toString("base64url"), rawId: credId.toString("base64url"), type: "public-key",
    response: { clientDataJSON: clientDataJSON.toString("base64url"), attestationObject: attestationObject.toString("base64url"), transports: ["internal"] },
    clientExtensionResults: {}, authenticatorAttachment: "platform",
  };
}

/* ---- reservations ---------------------------------------------------- */
let n = 0;
async function reserve(over: Partial<typeof schema.enquiries.$inferInsert> = {}) {
  n++;
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const cdId = `CD-YORK-${[0, 1, 2, 3].map(i => alphabet[Math.floor(n / 31 ** i) % 31]).join("")}`;
  const id = `enq-${randomUUID()}`;
  await handle.db.insert(schema.enquiries).values({
    id, reference: `CD-T${String(n).padStart(5, "0")}`, kind: "early_access", email: `owner${n}@yorkfx.test`,
    name: "Daniel Okafor", status: "invited", cdId,
    details: { firstName: "Daniel", lastName: "Okafor", shopName: "Harbour Exchange" }, ...over,
  });
  return { id, cdId, email: `owner${n}@yorkfx.test` };
}
const cookieFrom = (res: { cookies: { name: string; value: string }[] }): Record<string, string> => {
  const c = res.cookies.find((x) => x.name === "cd_enrol_attempt");
  return c ? { cd_enrol_attempt: c.value } : {};
};
const post = (url: string, payload: unknown, cookies: Record<string, string> = {}, ip = "198.51.100.9") =>
  app.inject({ method: "POST", url, payload: payload as object, cookies, remoteAddress: ip });

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handle = await createDb();
  app = Fastify();
  await app.register(cookie);
  door = createIdDoor({ db: handle.db, logRefusal: () => {} });
  registerCredentialRoutes(app, handle.db, door, {
    env: ENV, http, mail: async () => "simulated",
    breachRange: async (prefix) => {
      if (rangeDown) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return [...breached].filter((h) => h.startsWith(prefix)).map((h) => `${h.slice(5)}:12`).concat(["00000000000000000000000000000000000:0"]).join("\r\n");
    },
  });
  await app.ready();
});
afterAll(async () => { await app.close(); await handle.close(); });
beforeEach(() => { door.reset(); breached = new Set(); rangeDown = false; clearJwksCache(); });

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").toUpperCase();

describe("the account state machine", () => {
  it("moves only along reserved → enrolling → verified → active", async () => {
    expect(allowedFrom("enrolling")).toEqual(["reserved", "enrolling"]);
    expect(allowedFrom("verified")).toEqual(["enrolling"]);
    expect(allowedFrom("active")).toEqual(["verified"]);
    const { id } = await reserve();
    expect((await loadAccount(handle.db, id)).state).toBe("reserved");
    expect(await advance(handle.db, id, "verified")).toBe(false);
    expect(await advance(handle.db, id, "active")).toBe(false);
    expect(await advance(handle.db, id, "enrolling")).toBe(true);
    expect(await advance(handle.db, id, "verified")).toBe(true);
    expect(await advance(handle.db, id, "enrolling")).toBe(false);
    expect(await advance(handle.db, id, "active")).toBe(true);
    expect((await loadAccount(handle.db, id)).state).toBe("active");
  });
});

describe("D. email and password", () => {
  it("knows the rule: 12 characters, no forced symbol, leaked and local-list refused", async () => {
    const ok = async () => "00000000000000000000000000000000000:0";
    expect(lengthOf("ééééééééééé")).toBe(11);
    expect((await checkPassword("short pass", "Harbour Exchange", ok)).ok).toBe(false);
    expect(await checkPassword("four plain words here", "Harbour Exchange", ok)).toEqual({ ok: true });
    expect((await checkPassword("harbourexchange99", "Harbour Exchange", ok) as { reason: string }).reason).toBe("local_list");
    expect((await checkPassword("MyPassword-is-long", "Harbour Exchange", ok) as { reason: string }).reason).toBe("local_list");
    const pw = "correct horse battery";
    const range = async (prefix: string) => (sha1(pw).startsWith(prefix) ? `${sha1(pw).slice(5)}:3\r\n00000000000000000000000000000000000:0` : "00000000000000000000000000000000000:0");
    expect(await isBreached(pw, range)).toBe(true);
    expect(await isBreached("something else entirely", range)).toBe(false);
  });

  it("sends only the first five characters of the SHA-1 to the range", async () => {
    const seen: string[] = [];
    await isBreached("a perfectly long password", async (p) => { seen.push(p); return "00000000000000000000000000000000000:0"; });
    expect(seen).toEqual([sha1("a perfectly long password").slice(0, 5)]);
  });

  it("saves an Argon2id hash, moves reserved → enrolling, and says nothing about the owner", async () => {
    const { id, cdId, email } = await reserve();
    const res = await post(`/api/onboarding/${cdId}/password`, { password: "four plain words here", confirm: "four plain words here" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, kind: "password", state: "enrolling", codeSent: true });
    expect(res.body).not.toContain(email);
    expect(res.cookies.find((c) => c.name === "cd_enrol_attempt")?.httpOnly).toBe(true);
    const cred = (await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, id)))[0]!;
    expect(cred.passwordHash).toMatch(/^\$argon2id\$/);
    expect(cred.passwordHash).not.toContain("four plain");
    expect(cred.verifiedAt).toBeNull();
    expect(await verifyPassword("four plain words here", cred.passwordHash!)).toBe(true);
  });

  it("refuses under 12, a mismatch, a leaked one (422) and an unchecked one (503)", async () => {
    const { cdId } = await reserve();
    const url = `/api/onboarding/${cdId}/password`;
    expect((await post(url, { password: "only eleven", confirm: "only eleven" })).json().error).toBe("password_too_short");
    expect((await post(url, { password: "four plain words here", confirm: "four plain words her" })).statusCode).toBe(422);
    breached.add(sha1("leaked but long enough"));
    const leaked = await post(url, { password: "leaked but long enough", confirm: "leaked but long enough" });
    expect(leaked.statusCode).toBe(422);
    expect(leaked.json().detail).toBe("That password has appeared in a leak. Pick another.");
    rangeDown = true;
    const down = await post(url, { password: "four plain words here", confirm: "four plain words here" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe("password_check_unavailable");
    expect((await handle.db.select().from(schema.signupCredentials)).filter((c) => c.kind === "password" && c.passwordHash?.includes("leaked"))).toHaveLength(0);
  });
});

describe("A. passkey", () => {
  it("offers ES256 + RS256, a discoverable credential, UV required, attestation none, and no email", async () => {
    const { cdId, email } = await reserve();
    const res = await post(`/api/onboarding/${cdId}/passkey/options`, {});
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json().options;
    expect(o.rp).toEqual({ id: RP_ID, name: "CurrencyDesk" });
    expect(o.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-7, -257]);
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.authenticatorSelection.authenticatorAttachment).toBeUndefined();
    expect(o.attestation).toBe("none");
    expect(o.user.name).toBe(cdId);
    expect(o.user.displayName).toBe("Harbour Exchange");
    expect(res.body).not.toContain(email);
    expect(res.body).not.toContain("Daniel");
  });

  it("saves a verified registration and moves to enrolling; the challenge is one use", async () => {
    const { id, cdId } = await reserve();
    const opt = await post(`/api/onboarding/${cdId}/passkey/options`, {});
    const jar = cookieFrom(opt);
    const credential = makePasskey(opt.json().options.challenge);
    const ok = await post(`/api/onboarding/${cdId}/passkey/verify`, { response: credential, deviceLabel: "This Mac" }, jar);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ ok: true, kind: "passkey", state: "enrolling", codeSent: true });
    const cred = (await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, id)))[0]!;
    expect(cred).toMatchObject({ kind: "passkey", passkeyId: credential.id, deviceLabel: "This Mac", signCount: 0 });
    expect(cred.publicKey).toBeTruthy();
    expect((await post(`/api/onboarding/${cdId}/passkey/verify`, { response: credential }, jar)).statusCode).toBe(400);
  });

  it("refuses a wrong origin, a wrong RP ID, no user verification, or another browser's challenge", async () => {
    const { cdId } = await reserve();
    for (const bad of [{ origin: "https://evil.test" }, { rpId: "evil.test" }, { uv: false }]) {
      const opt = await post(`/api/onboarding/${cdId}/passkey/options`, {});
      const res = await post(`/api/onboarding/${cdId}/passkey/verify`, { response: makePasskey(opt.json().options.challenge, bad) }, cookieFrom(opt));
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().detail).toBe("The passkey wasn't created. Nothing was saved. Try again, or choose another way.");
    }
    const opt = await post(`/api/onboarding/${cdId}/passkey/options`, {});
    const other = await post(`/api/onboarding/${cdId}/passkey/options`, {});
    expect((await post(`/api/onboarding/${cdId}/passkey/verify`, { response: makePasskey(opt.json().options.challenge) }, cookieFrom(other))).statusCode).toBe(400);
  });
});

describe("B / C. Google and Microsoft", () => {
  const start = async (cdId: string, provider: string) => {
    const res = await app.inject({ method: "GET", url: `/api/onboarding/${cdId}/sso/${provider}/start`, remoteAddress: "198.51.100.9" });
    expect(res.statusCode, res.body).toBe(200);
    const url = new URL(res.json().url);
    return { url, jar: cookieFrom(res), state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
  };
  const now = () => Math.floor(Date.now() / 1000);

  it("starts with PKCE, openid email profile, select_account, and no login_hint", async () => {
    const { cdId, email } = await reserve();
    const { url } = await start(cdId, "google");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("login_hint")).toBe(false);
    expect(url.toString()).not.toContain(encodeURIComponent(email));
  });

  it("links (provider, sub) when the verified email is the one applied with, in any case or Unicode form", async () => {
    const { id, cdId, email } = await reserve();
    const s = await start(cdId, "google");
    nextClaims = { iss: "https://accounts.google.com", aud: "google-client", exp: now() + 300, nonce: s.nonce, sub: "g-123", email: email.toUpperCase(), email_verified: true };
    const res = await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, kind: "google", state: "enrolling", codeSent: true });
    const cred = (await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, id)))[0]!;
    expect(cred).toMatchObject({ kind: "google", ssoSubject: "g-123" });
    expect(sameEmail("Ｏwner@x.test".normalize("NFKC"), "owner@x.test")).toBe(true);
    expect(sameEmail("é@x.test", "é@x.test")).toBe(true);
  });

  it("refuses another account with 409 email_mismatch, never naming the reservation email", async () => {
    const { cdId, email } = await reserve();
    const s = await start(cdId, "google");
    nextClaims = { iss: "https://accounts.google.com", aud: "google-client", exp: now() + 300, nonce: s.nonce, sub: "g-9", email: "someone@else.test", email_verified: true };
    const res = await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "email_mismatch", detail: "That Google account isn't the email you applied with. Use the account for that email." });
    expect(res.body).not.toContain(email);
    const logged = (await handle.db.select().from(schema.auditEvents)).filter((e) => e.action === "sso.refused_mismatch");
    expect(logged.length).toBeGreaterThan(0);
  });

  it("refuses an unverified email, a wrong nonce, a reused state and a forged signature", async () => {
    const { cdId, email } = await reserve();
    const base = (s: { nonce: string }) => ({ iss: "https://accounts.google.com", aud: "google-client", exp: now() + 300, nonce: s.nonce, sub: "g-1", email });
    let s = await start(cdId, "google");
    nextClaims = { ...base(s), email_verified: false };
    expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar)).statusCode).toBe(409);
    s = await start(cdId, "google");
    nextClaims = { ...base(s), nonce: "other", email_verified: true };
    expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar)).statusCode).toBe(400);
    expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar)).statusCode).toBe(400);
    s = await start(cdId, "google");
    const forged = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const realToken = idToken;
    idToken = (claims) => {
      const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1" })).toString("base64url");
      const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
      return `${h}.${p}.${signData("RSA-SHA256", Buffer.from(`${h}.${p}`), forged.privateKey).toString("base64url")}`;
    };
    nextClaims = { ...base(s), email_verified: true };
    expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar)).statusCode).toBe(400);
    idToken = realToken;
  });

  it("Microsoft needs oid and tid and an issuer for that tenant", async () => {
    const { cdId, email } = await reserve();
    let s = await start(cdId, "microsoft");
    nextClaims = { iss: "https://login.microsoftonline.com/t-1/v2.0", aud: "ms-client", exp: now() + 300, nonce: s.nonce, sub: "m-1", tid: "t-1", email, email_verified: true };
    expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "microsoft", code: "c", state: s.state }, s.jar)).statusCode).toBe(400);
    s = await start(cdId, "microsoft");
    nextClaims = { iss: "https://login.microsoftonline.com/t-1/v2.0", aud: "ms-client", exp: now() + 300, nonce: s.nonce, sub: "m-1", oid: "o-1", tid: "t-1", email, email_verified: true };
    const ok = await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "microsoft", code: "c", state: s.state }, s.jar);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("rejects tokens for another authorized party or before their valid time", async () => {
    for (const extra of [{ aud: ["google-client", "other"], azp: "other" }, { nbf: now() + 3600 }, { iat: now() + 3600 }]) {
      const { cdId, email } = await reserve();
      const s = await start(cdId, "google");
      nextClaims = { iss: "https://accounts.google.com", aud: "google-client", exp: now() + 7200, nonce: s.nonce, sub: "g-time", email, email_verified: true, ...extra };
      expect((await post(`/api/onboarding/${cdId}/sso/callback`, { provider: "google", code: "c", state: s.state }, s.jar)).statusCode).toBe(400);
    }
  });

  it("answers 503 when a provider is not configured", async () => {
    const bare = Fastify();
    await bare.register(cookie);
    registerCredentialRoutes(bare, handle.db, door, { env: {} as NodeJS.ProcessEnv });
    const { cdId } = await reserve();
    expect((await bare.inject({ method: "GET", url: `/api/onboarding/${cdId}/sso/google/start` })).statusCode).toBe(503);
    await bare.close();
  });
});

describe("who may choose", () => {
  it("is a 404 for an unknown ID, 409 once verified, 409 once the desk is open", async () => {
    expect((await post("/api/onboarding/CD-NONE-2222/password", { password: "four plain words here", confirm: "four plain words here" })).statusCode).toBe(404);
    const v = await reserve();
    await advance(handle.db, (await loadAccount(handle.db, v.id)).enquiryId, "enrolling");
    await advance(handle.db, v.id, "verified");
    expect((await post(`/api/onboarding/${v.cdId}/passkey/options`, {})).json().error).toBe("already_verified");
    const open = await reserve({ status: "accepted" });
    expect((await post(`/api/onboarding/${open.cdId}/passkey/options`, {})).json().error).toBe("already_open");
  });

  it("lets two browsers each hold a candidate; neither is verified until the code", async () => {
    const { id, cdId } = await reserve();
    await post(`/api/onboarding/${cdId}/password`, { password: "four plain words here", confirm: "four plain words here" });
    await post(`/api/onboarding/${cdId}/password`, { password: "another set of words", confirm: "another set of words" }, {}, "203.0.113.77");
    const creds = await handle.db.select().from(schema.signupCredentials).where(eq(schema.signupCredentials.enquiryId, id));
    expect(creds).toHaveLength(2);
    expect(new Set(creds.map((c) => c.attemptHash)).size).toBe(2);
    expect(creds.every((c) => c.verifiedAt === null)).toBe(true);
  });

  it("counts refused passkeys and SSO against the ID's 10-miss limit", async () => {
    const { cdId } = await reserve();
    for (let i = 0; i < 10; i++) {
      await post(`/api/onboarding/${cdId}/passkey/verify`, { response: makePasskey("bogus") }, { cd_enrol_attempt: "a".repeat(43) }, `192.0.2.${i}`);
    }
    expect((await post(`/api/onboarding/${cdId}/passkey/options`, {}, {}, "192.0.2.200")).statusCode).toBe(429);
  });
});

/* A flood of well-shaped IDs nobody holds, from addresses in one IPv6 /64.
   The door's tables remember 10,000 keys each; these floods go past that. */
describe("a crowd of made-up IDs", () => {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const madeUp = (i: number) => `CD-QQQQ-${[0, 1, 2, 3].map((k) => alphabet[Math.floor(i / 31 ** k) % 31]).join("")}`;
  const options = (cdId: string, ip: string) => post(`/api/onboarding/${cdId}/passkey/options`, {}, {}, ip);
  const flood = async (addresses: number, idsEach: number) => {
    const answers: Record<number, number> = {};
    for (let a = 0; a < addresses; a++) {
      for (let k = 0; k < idsEach; k++) {
        const { statusCode } = await options(madeUp(a * idsEach + k), `2001:db8::${a.toString(16)}`);
        answers[statusCode] = (answers[statusCode] ?? 0) + 1;
      }
    }
    return answers;
  };

  it("does not refuse a real ID from a fresh address: 1,001 addresses, 10 made-up IDs each", async () => {
    const { cdId } = await reserve();
    const answers = await flood(1001, 10);
    expect((await options(cdId, "198.51.100.77")).statusCode).toBe(200);
    expect(answers).toEqual({ 404: 10_010 });
  }, 120_000);

  it("leaves a fresh address its room, and a real ID its own limit, past what the door remembers", async () => {
    const busy = await reserve();
    const quiet = await reserve();
    const tries: number[] = [];
    for (let i = 0; i < 13; i++) tries.push((await options(busy.cdId, `192.0.2.${i}`)).statusCode);
    expect(tries).toEqual([...Array<number>(12).fill(200), 429]);
    await flood(10_001, 1);
    expect((await options(quiet.cdId, "198.51.100.78")).statusCode).toBe(200);
    expect((await options(busy.cdId, "198.51.100.79")).statusCode).toBe(429);
  }, 120_000);
});


describe("review: external boundaries", () => {
  it("does not choose a permanent relying party when configuration is absent", async () => {
    const bare = Fastify();
    await bare.register(cookie);
    registerCredentialRoutes(bare, handle.db, door, { env: {} });
    const { cdId } = await reserve();
    expect((await bare.inject({ method: "POST", url: `/api/onboarding/${cdId}/passkey/options` })).statusCode).toBe(503);
    await bare.close();
  });
  it("treats malformed breach-range replies as unavailable", async () => {
    for (const body of ["<html>unavailable</html>", "", "ABC:1"]) {
      expect(await checkPassword("four plain words here", "Harbour", async () => body)).toMatchObject({ ok: false, reason: "check_unavailable" });
    }
  });
  it("does not echo provider or authenticator payloads into refusal logs", async () => {
    const { cdId } = await reserve();
    const opt = await post(`/api/onboarding/${cdId}/passkey/options`, {});
    const secretOrigin = "https://private-name-and-token.invalid";
    await post(`/api/onboarding/${cdId}/passkey/verify`, { response: makePasskey(opt.json().options.challenge, { origin: secretOrigin }) }, cookieFrom(opt));
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).not.toContain(secretOrigin);
  });
});
