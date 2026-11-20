/* CD-276. Microsoft sign-in matches tid + oid only.
   The common authority is used. A shop allowlist stays off until set.
   No network. */
import { generateKeyPairSync, randomUUID, sign as signData } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createDb, schema, type DbHandle } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { clearJwksCache, type FetchJson } from "../src/auth/oidc.js";
import { setSsoHttp } from "../src/auth/sso-flow.js";

const ORIGIN = "https://currencydesk-staging.onrender.com";
const TID = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "m1", alg: "RS256", use: "sig" };
let nextClaims: Record<string, unknown> = {};

function idToken(claims: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "m1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${h}.${p}.${signData("RSA-SHA256", Buffer.from(`${h}.${p}`), rsa.privateKey).toString("base64url")}`;
}

const http: FetchJson = async (url, init) => {
  if (url.includes("certs") || url.includes("keys")) return { keys: [jwk] };
  if (init.method === "POST") return { id_token: idToken(nextClaims), access_token: "ms-access-should-not-be-stored", refresh_token: "ms-refresh-should-not-be-stored" };
  throw new Error(`unexpected ${url}`);
};

let handle: DbHandle;
let app: FastifyInstance;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  process.env.PGLITE_MEMORY = "1";
  for (const key of ["SIGNIN_MICROSOFT", "SIGNIN_GOOGLE", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "SSO_SIGNIN_REDIRECT_URI", "SSO_LINK_REDIRECT_URI"]) {
    saved[key] = process.env[key];
  }
  process.env.SIGNIN_MICROSOFT = "1";
  process.env.SIGNIN_GOOGLE = "0";
  process.env.MICROSOFT_CLIENT_ID = "ms-client";
  process.env.MICROSOFT_CLIENT_SECRET = "ms-secret";
  process.env.SSO_SIGNIN_REDIRECT_URI = `${ORIGIN}/auth/sso/callback`;
  process.env.SSO_LINK_REDIRECT_URI = `${ORIGIN}/auth/sso/link/callback`;
  handle = await createDb();
  await handle.db.execute(sql`DELETE FROM signin_failures WHERE bucket LIKE 'sso-ip:%' OR bucket LIKE 'sso:%'`);
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

async function person(tag: string, oid: string, tid: string) {
  const id = randomUUID().slice(0, 8);
  const tenantId = `tnt-${id}`;
  const legalEntityId = `le-${id}`;
  const branchId = `br-${id}`;
  const userId = `${tenantId}:${tag}`;
  await handle.db.insert(schema.tenants).values({ id: tenantId, name: `Desk ${tag} ${id}` });
  await handle.db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: `LE ${id}`, jurisdiction: "FINTRAC" });
  await handle.db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "Main", province: "ON" });
  await handle.db.insert(schema.staffUsers).values({
    id: userId, tenantId, legalEntityId, branchId, staffId: tag, name: tag, role: "teller",
    authorizedBranchIds: [branchId], passwordHash: await hashPassword("correct-horse"),
  });
  await handle.db.insert(schema.staffIdentities).values({
    id: `idn-${id}`, tenantId, staffUserId: userId, provider: "microsoft",
    issuer: `https://login.microsoftonline.com/${tid}/v2.0`, subject: oid, msTid: tid,
  });
  return { tenantId, userId };
}

function claims(nonce: string, oid: string, tid: string, sub: string) {
  const now = Math.floor(Date.now() / 1000);
  nextClaims = {
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    sub, oid, tid, aud: "ms-client", exp: now + 300, iat: now, nonce,
    email: "not-a-match-key@contoso.com",
    preferred_username: "not-a-match-key@contoso.com",
  };
}

async function callback(nonce: string, state: string, oid: string, tid = TID, sub = "ms-sub-not-used") {
  clearJwksCache();
  claims(nonce, oid, tid, sub);
  return app.inject({ method: "GET", url: `/auth/sso/callback?code=good&state=${state}` });
}

describe("Microsoft sign-in", () => {
  it("uses the common authority and stays off when the flag is off", async () => {
    process.env.SIGNIN_MICROSOFT = "0";
    expect((await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" })).statusCode).toBe(503);
    process.env.SIGNIN_MICROSOFT = "1";
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start?returnTo=/app" });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/sso/callback`);
  });

  it("matches tid and oid, ignores sub and email, and does not create a shop", async () => {
    const oid = `oid-${randomUUID()}`;
    await person("ada", oid, TID);
    const before = await handle.db.execute(sql`SELECT count(*)::int AS n FROM staff_users`);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const loc = new URL(start.headers.location as string);
    const ok = await callback(loc.searchParams.get("nonce") ?? "", loc.searchParams.get("state") ?? "", oid, TID, "different-sub");
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe("/app");
    const wrongOid = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const wrongLoc = new URL(wrongOid.headers.location as string);
    const missed = await callback(wrongLoc.searchParams.get("nonce") ?? "", wrongLoc.searchParams.get("state") ?? "", `other-${oid}`, TID, "different-sub");
    expect(missed.headers.location).toBe("/login?sso=refused");
    const after = await handle.db.execute(sql`SELECT count(*)::int AS n FROM staff_users`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const stored = JSON.stringify(await handle.db.select().from(schema.authChallenges));
    expect(stored).not.toContain("ms-access-should-not-be-stored");
    expect(stored).not.toContain("not-a-match-key@contoso.com");
  });

  it("leaves the tenant allowlist off until a shop sets one", async () => {
    const oid = `oid-${randomUUID()}`;
    const open = await person("bea", oid, TID);
    const row = (await handle.db.select({ list: schema.tenants.msTenantAllowlist }).from(schema.tenants).where(eq(schema.tenants.id, open.tenantId)).limit(1))[0];
    expect(row?.list ?? null).toBeNull();
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const loc = new URL(start.headers.location as string);
    const allowed = await callback(loc.searchParams.get("nonce") ?? "", loc.searchParams.get("state") ?? "", oid);
    expect(allowed.statusCode, allowed.body).toBe(303);
    expect(allowed.headers.location).toBe("/app");

    await handle.db.update(schema.tenants).set({ msTenantAllowlist: [OTHER] }).where(eq(schema.tenants.id, open.tenantId));
    const blockedStart = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const blockedLoc = new URL(blockedStart.headers.location as string);
    const blocked = await callback(blockedLoc.searchParams.get("nonce") ?? "", blockedLoc.searchParams.get("state") ?? "", oid);
    expect(blocked.headers.location).toBe("/login?sso=refused");

    await handle.db.update(schema.tenants).set({ msTenantAllowlist: [TID] }).where(eq(schema.tenants.id, open.tenantId));
    const openStart = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const openLoc = new URL(openStart.headers.location as string);
    const again = await callback(openLoc.searchParams.get("nonce") ?? "", openLoc.searchParams.get("state") ?? "", oid);
    expect(again.headers.location).toBe("/app");
  });

  it("asks which shop when the same oid is linked twice and does not pick one", async () => {
    const oid = `oid-${randomUUID()}`;
    await person("cara", oid, TID);
    await person("dan", oid, TID);
    const start = await app.inject({ method: "GET", url: "/api/auth/sso/microsoft/start" });
    const loc = new URL(start.headers.location as string);
    const res = await callback(loc.searchParams.get("nonce") ?? "", loc.searchParams.get("state") ?? "", oid);
    expect(res.headers.location).toBe("/login?sso=shops");
    expect(String(res.headers["set-cookie"])).not.toContain("cdos_session=");
    const pending = /cdos_sso_pending=([^;]+)/.exec(String(res.headers["set-cookie"]))?.[1];
    const shops = await app.inject({ method: "GET", url: "/api/auth/sso/shops", headers: { cookie: `cdos_sso_pending=${pending}` } });
    const body = shops.json() as { shops: { name: string }[] };
    expect(body.shops).toHaveLength(2);
  });
});
