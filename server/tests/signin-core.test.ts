/* CD-273 shared sign-in core.
   Sign-up's verifier stays the one the credential tests already drive.
   The sign-in verifier adds the RSA floor and keeps every claim check
   inside itself. Password sign-in still finishes through completeSignIn,
   including the must-change-password gate. */
import { generateKeyPairSync, sign as signData } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { seed, DEMO } from "../src/seed.js";
import { buildApp } from "../src/app.js";
import {
  allowReturnTo,
  clearJwksCache,
  identityFromClaims,
  linkRedirect,
  providerConfig,
  signInProviderConfig,
  signInRedirect,
  verifySignInIdToken,
  type FetchJson,
} from "../src/auth/oidc.js";

const ORIGIN = "https://currencydesk-staging.onrender.com";
const ENV = {
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  MICROSOFT_CLIENT_ID: "ms-client",
  MICROSOFT_CLIENT_SECRET: "ms-secret",
  SSO_REDIRECT_URI: `${ORIGIN}/onboarding/sso`,
  SSO_SIGNIN_REDIRECT_URI: `${ORIGIN}/auth/sso/callback`,
  SSO_LINK_REDIRECT_URI: `${ORIGIN}/auth/sso/link/callback`,
} as NodeJS.ProcessEnv;

const rsa2048 = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1024 });
const jwk2048 = { ...rsa2048.publicKey.export({ format: "jwk" }), kid: "k2048", alg: "RS256", use: "sig" };
const jwk1024 = { ...rsa1024.publicKey.export({ format: "jwk" }), kid: "k1024", alg: "RS256", use: "sig" };

function token(key: typeof rsa2048, kid: string, claims: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = signData("RSA-SHA256", Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url");
  return `${h}.${p}.${sig}`;
}

function httpFor(keys: unknown): FetchJson {
  return async (url) => {
    if (url.includes("certs") || url.includes("keys")) return { keys };
    throw new Error(`unexpected ${url}`);
  };
}

const now = Math.floor(Date.now() / 1000);

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  handle = await createDb();
  await seed(handle.db);
  app = await buildApp(handle.db);
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

describe("sign-in redirect URIs fail closed", () => {
  it("accepts the exact staging paths and rejects a query, a fragment, or the wrong path", () => {
    expect(signInRedirect(ENV)?.href).toBe(`${ORIGIN}/auth/sso/callback`);
    expect(linkRedirect(ENV)?.href).toBe(`${ORIGIN}/auth/sso/link/callback`);
    expect(signInRedirect({ ...ENV, SSO_SIGNIN_REDIRECT_URI: `${ORIGIN}/auth/sso/callback?next=1` })).toBeNull();
    expect(signInRedirect({ ...ENV, SSO_SIGNIN_REDIRECT_URI: `${ORIGIN}/auth/sso/callback#x` })).toBeNull();
    expect(signInRedirect({ ...ENV, SSO_SIGNIN_REDIRECT_URI: `${ORIGIN}/onboarding/sso` })).toBeNull();
    expect(signInRedirect({ ...ENV, SSO_SIGNIN_REDIRECT_URI: "" })).toBeNull();
    expect(linkRedirect({ ...ENV, SSO_LINK_REDIRECT_URI: "http://currencydesk-staging.onrender.com/auth/sso/link/callback" })).toBeNull();
    expect(providerConfig("google", ENV)?.redirectUri).toBe(`${ORIGIN}/onboarding/sso`);
  });

  it("allows only a relative return path", () => {
    expect(allowReturnTo("/app")).toBe("/app");
    expect(allowReturnTo("/login")).toBe("/login");
    expect(allowReturnTo("https://evil.example/app")).toBe("/app");
    expect(allowReturnTo("//evil.example")).toBe("/app");
    expect(allowReturnTo("/app?x=1")).toBe("/app");
  });
});

describe("sign-in ID token checks", () => {
  it("rejects a short RSA key, a scheme-less Google issuer, and a bad nonce", async () => {
    clearJwksCache();
    const cfg = signInProviderConfig("google", "signin", ENV);
    expect(cfg).not.toBeNull();
    const good = {
      iss: "https://accounts.google.com",
      sub: "google-sub",
      aud: "google-client",
      exp: now + 300,
      iat: now,
      nonce: "nonce-1",
      email: "person@example.com",
      email_verified: true,
    };
    const accepted = await verifySignInIdToken(cfg!, token(rsa2048, "k2048", good), "nonce-1", httpFor([jwk2048]));
    expect(accepted?.sub).toBe("google-sub");
    expect(identityFromClaims(cfg!, accepted!)).toEqual({
      provider: "google",
      issuer: "https://accounts.google.com",
      subject: "google-sub",
      msTid: null,
    });
    clearJwksCache();
    expect(await verifySignInIdToken(cfg!, token(rsa1024, "k1024", good), "nonce-1", httpFor([jwk1024]))).toBeNull();
    clearJwksCache();
    expect(await verifySignInIdToken(
      cfg!,
      token(rsa2048, "k2048", { ...good, iss: "accounts.google.com" }),
      "nonce-1",
      httpFor([jwk2048]),
    )).toBeNull();
    clearJwksCache();
    expect(await verifySignInIdToken(cfg!, token(rsa2048, "k2048", good), "other-nonce", httpFor([jwk2048]))).toBeNull();
  });

  it("stores Microsoft oid and tid, not sub, and ignores the email", async () => {
    clearJwksCache();
    const cfg = signInProviderConfig("microsoft", "signin", ENV)!;
    const tid = "11111111-1111-1111-1111-111111111111";
    const claims = {
      iss: `https://login.microsoftonline.com/${tid}/v2.0`,
      sub: "ms-sub-not-the-key",
      oid: "ms-oid",
      tid,
      aud: "ms-client",
      exp: now + 300,
      iat: now,
      nonce: "nonce-ms",
      email: "someone@contoso.com",
      preferred_username: "someone@contoso.com",
    };
    const accepted = await verifySignInIdToken(cfg, token(rsa2048, "k2048", claims), "nonce-ms", httpFor([jwk2048]));
    expect(identityFromClaims(cfg, accepted!)).toEqual({
      provider: "microsoft",
      issuer: claims.iss,
      subject: "ms-oid",
      msTid: tid,
    });
    clearJwksCache();
    expect(await verifySignInIdToken(
      cfg,
      token(rsa2048, "k2048", { ...claims, iss: "https://login.microsoftonline.com/common/v2.0" }),
      "nonce-ms",
      httpFor([jwk2048]),
    )).toBeNull();
  });
});

describe("password sign-in goes through completeSignIn", () => {
  it("issues a fresh session and still enforces a required password change", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(first.statusCode).toBe(200);
    const body = first.json() as { user: { id: string; mustChangePassword: boolean } };
    expect(body.user.id).toBe("m.costa");
    expect(body.user.mustChangePassword).toBe(false);
    const cookie = String(first.headers["set-cookie"] ?? "");
    expect(cookie).toContain("cdos_session=");
    const row = (await handle.db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, "auth.login")).limit(20));
    const detail = row.map((event) => event.detail as { method?: string });
    expect(detail.some((item) => item.method === "password")).toBe(true);

    await handle.db.update(schema.staffUsers).set({ mustChangePassword: true }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { staffId: "m.costa", password: DEMO.password, tenantId: DEMO.tenantId },
    });
    expect(again.statusCode).toBe(200);
    const session = String(again.headers["set-cookie"]);
    const token = /cdos_session=([^;]+)/.exec(session)?.[1];
    const gated = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `cdos_session=${token}` },
    });
    expect(gated.statusCode).toBe(403);
    expect(gated.json()).toMatchObject({ error: "password_change_required" });
    await handle.db.update(schema.staffUsers).set({ mustChangePassword: false }).where(eq(schema.staffUsers.id, `${DEMO.tenantId}:m.costa`));
  });
});

describe("sign-up helper extraction keeps the redirect contract", () => {
  it("still refuses a sign-up redirect that is not /onboarding/sso", () => {
    expect(providerConfig("google", { ...ENV, SSO_REDIRECT_URI: `${ORIGIN}/auth/sso/callback` })).toBeNull();
  });
});
