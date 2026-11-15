/* ============================================================
   Sign-up v2.1, B / C. Continue with Google · Microsoft
   (SIGNUP-LOGIC §3.1 B/C).

   OIDC authorization code + PKCE (S256), scopes `openid email profile`
   only, `prompt=select_account`, and NO login_hint: before the email code
   the reservation email must not appear on the provider's screen to
   somebody who only typed the ID.

   The callback exchanges the code (timeout), checks the ID token's
   signature against the provider's published keys (timeout, cached), its
   issuer, audience, expiry and nonce, and then requires:
     - email_verified = true;
     - the email equal to the one applied with (case-insensitive, NFC);
     - for Microsoft, oid and tid present.
   A mismatch is refused (409 email_mismatch) and the message never names
   the reservation email. The link is (provider, sub), never the email.

   Microsoft: a v2.0 ID token carries email_verified only when the app
   registration asks for it (optional claim). Without it every Microsoft
   account is refused, which is the safe failure. Noted for CTO.

   Not configured (no client ID or secret): the provider answers 503 and
   the page hides the button. Nothing here invents a fallback.
   ============================================================ */
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature, type JsonWebKey } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { CHALLENGE_TTL_MS } from "./passkey.js";

export type Provider = "google" | "microsoft";
export const PROVIDERS: readonly Provider[] = ["google", "microsoft"];
export const SSO_TIMEOUT_MS = 8_000;

export type ProviderConfig = {
  provider: Provider; clientId: string; clientSecret: string; redirectUri: string;
  authorize: string; token: string; jwks: string;
  issuerOk: (iss: string, claims: Record<string, unknown>) => boolean;
};

export function providerConfig(provider: Provider, env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  const P = provider.toUpperCase();
  const clientId = env[`${P}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${P}_CLIENT_SECRET`]?.trim();
  const redirectUri = env.SSO_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  switch (provider) {
    case "google":
      return {
        provider, clientId, clientSecret, redirectUri,
        authorize: "https://accounts.google.com/o/oauth2/v2/auth",
        token: "https://oauth2.googleapis.com/token",
        jwks: "https://www.googleapis.com/oauth2/v3/certs",
        issuerOk: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
      };
    case "microsoft":
      return {
        provider, clientId, clientSecret, redirectUri,
        authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        jwks: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
        issuerOk: (iss, c) => typeof c.tid === "string" && iss === `https://login.microsoftonline.com/${c.tid}/v2.0`,
      };
  }
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

/** Starts the round trip: a one-use state, a PKCE verifier and a nonce, five minutes. */
export async function startSso(db: Db, cfg: ProviderConfig, o: { enquiryId: string; attemptHash: string }): Promise<string> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await db.insert(schema.signupChallenges).values({
    id: `chl-${randomUUID()}`, enquiryId: o.enquiryId, purpose: cfg.provider,
    challenge: createHash("sha256").update(state).digest("hex"), verifier, nonce,
    attemptHash: o.attemptHash, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code",
    scope: "openid email profile", prompt: "select_account", state, nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
  });
  return `${cfg.authorize}?${q.toString()}`;
}

/** JSON over HTTP with a timeout. Replaced in tests; there is no live network there. */
export type FetchJson = (url: string, init: { method: "GET" | "POST"; body?: URLSearchParams; signal: AbortSignal }) => Promise<unknown>;
export const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    method: init.method, signal: init.signal,
    ...(init.body ? { body: init.body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
};

const jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();
const JWKS_TTL_MS = 60 * 60 * 1000;
export const clearJwksCache = (): void => jwksCache.clear();

async function keysFor(cfg: ProviderConfig, http: FetchJson, fresh = false): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(cfg.jwks);
  if (!fresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const body = (await http(cfg.jwks, { method: "GET", signal: AbortSignal.timeout(SSO_TIMEOUT_MS) })) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(cfg.jwks, { at: Date.now(), keys });
  return keys;
}

/** An RS256 ID token's claims, once its signature checks against the provider's keys. */
export async function verifyIdToken(cfg: ProviderConfig, token: string, http: FetchJson): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let jwk = (await keysFor(cfg, http)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) jwk = (await keysFor(cfg, http, true)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  return ok ? claims : null;
}

/** Unicode-normalised, case-insensitive (§3.1 B step 2). */
export const sameEmail = (a: string, b: string): boolean =>
  a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase();

export type SsoResult =
  | { ok: true; subject: string; tenant: string | null }
  | { ok: false; status: 400 | 409 | 502; reason: "no_state" | "bad_token" | "email_unverified" | "email_mismatch" | "provider_unavailable" };

export async function finishSso(
  db: Db,
  cfg: ProviderConfig,
  o: { enquiryId: string; attemptHash: string; code: string; state: string; ownerEmail: string },
  http: FetchJson = fetchJson,
): Promise<SsoResult> {
  const stateHash = createHash("sha256").update(o.state).digest("hex");
  const row = (await db.select().from(schema.signupChallenges).where(and(
    eq(schema.signupChallenges.enquiryId, o.enquiryId), eq(schema.signupChallenges.purpose, cfg.provider),
    eq(schema.signupChallenges.challenge, stateHash), eq(schema.signupChallenges.attemptHash, o.attemptHash),
    isNull(schema.signupChallenges.usedAt), gt(schema.signupChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!row) return { ok: false, status: 400, reason: "no_state" };
  const spent = await db.update(schema.signupChallenges).set({ usedAt: new Date() })
    .where(and(eq(schema.signupChallenges.id, row.id), isNull(schema.signupChallenges.usedAt))).returning();
  if (!spent.length) return { ok: false, status: 400, reason: "no_state" };

  let claims: Record<string, unknown> | null;
  try {
    const tokens = (await http(cfg.token, {
      method: "POST", signal: AbortSignal.timeout(SSO_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: "authorization_code", code: o.code, redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: row.verifier ?? "",
      }),
    })) as { id_token?: unknown };
    claims = typeof tokens?.id_token === "string" ? await verifyIdToken(cfg, tokens.id_token, http) : null;
  } catch (err) {
    console.warn(`[signup sso] ${cfg.provider} unavailable: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    return { ok: false, status: 502, reason: "provider_unavailable" };
  }
  if (!claims) return { ok: false, status: 400, reason: "bad_token" };
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const audOk = aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId));
  if (!audOk || typeof claims.iss !== "string" || !cfg.issuerOk(claims.iss, claims)
    || typeof claims.exp !== "number" || claims.exp < now - 60 || claims.nonce !== row.nonce
    || typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, status: 400, reason: "bad_token" };
  }
  if (cfg.provider === "microsoft" && (typeof claims.oid !== "string" || typeof claims.tid !== "string")) {
    return { ok: false, status: 400, reason: "bad_token" };
  }
  if (claims.email_verified !== true) return { ok: false, status: 409, reason: "email_unverified" };
  if (typeof claims.email !== "string" || !sameEmail(claims.email, o.ownerEmail)) {
    return { ok: false, status: 409, reason: "email_mismatch" };
  }
  return { ok: true, subject: claims.sub, tenant: cfg.provider === "microsoft" ? String(claims.tid) : null };
}
