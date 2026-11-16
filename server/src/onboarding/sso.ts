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

   Microsoft: its ID-token and optional-claims references list no
   email_verified claim at all, and say `email` is mutable and never for
   authorization (checked 16 Nov 2026; discovery's claims_supported has no
   email_verified either). So under this rule every Microsoft account is
   refused, honestly as email_unverified, which is the safe failure. Any
   other rule for Microsoft is a protected spec exception for CTO, not
   something this file assumes. preferred_username / UPN is never used.

   Google: its published example sends email_verified as the string
   "true"; the boolean and that string mean the same and nothing else does.

   SSO_REDIRECT_URI must be exactly <origin>/onboarding/sso, over https
   (http only for localhost outside production): anything else cannot hand
   the code back to the sign-up page, so the provider is not offered.

   Not configured (no client ID or secret): the provider answers 503 and
   the page hides the button. Nothing here invents a fallback.
   ============================================================ */
import { z } from "zod";
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
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
  const redirectUri = ssoRedirect(env)?.href;
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

/** The one redirect the sign-up page can take back (web/signup-sso.html), or null. */
function ssoRedirect(env: NodeJS.ProcessEnv): URL | null {
  const raw = env.SSO_REDIRECT_URI?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  const local = url.hostname === "localhost" && url.protocol === "http:" && env.NODE_ENV !== "production";
  if (url.username || url.password || url.search || url.hash || raw.includes("#") || url.pathname !== "/onboarding/sso"
    || !(url.protocol === "https:" || local)) return null;
  return url;
}

/** The origin Google and Microsoft send people back to, when that round trip can work. */
export const ssoOrigin = (env: NodeJS.ProcessEnv = process.env): string | null => ssoRedirect(env)?.origin ?? null;

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

/** HTTP failure without a provider body or description. Only the parsed
 * invalid_grant token error identifies a refused code; configuration, quota
 * and key-discovery failures must not count as guesses at the applicant ID. */
export class ProviderHttpError extends Error {
  constructor(host: string, readonly status: number, readonly oauthError: "invalid_grant" | null = null) {
    super(`${host} answered ${status}`);
    this.name = "ProviderHttpError";
  }
}

/** JSON over HTTP with a timeout. Replaced in tests; there is no live network there. */
export type FetchJson = (url: string, init: { method: "GET" | "POST"; body?: URLSearchParams; signal: AbortSignal }) => Promise<unknown>;
export const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, {
    method: init.method, signal: init.signal,
    ...(init.body ? { body: init.body, headers: { "content-type": "application/x-www-form-urlencoded" } } : {}),
  });
  if (!res.ok) {
    let oauthError: "invalid_grant" | null = null;
    if (init.method === "POST" && res.status === 400) {
      // Parse just the known code; never retain/log provider descriptions.
      const body: unknown = await res.json();
      const parsed = z.object({ error: z.literal("invalid_grant") }).safeParse(body);
      if (parsed.success) oauthError = parsed.data.error;
    }
    throw new ProviderHttpError(new URL(url).host, res.status, oauthError);
  }
  return res.json();
};

const jwkSchema = z.object({
  kty: z.literal("RSA"), kid: z.string().min(1), n: z.string().min(1), e: z.string().min(1),
  alg: z.literal("RS256").optional(), use: z.literal("sig").optional(),
});
const tokenClaims = z.object({
  iss: z.string(), sub: z.string().min(1), aud: z.union([z.string(), z.array(z.string()).min(1)]),
  exp: z.number().finite(), iat: z.number().finite().optional(), nbf: z.number().finite().optional(),
  azp: z.string().optional(), nonce: z.string(), email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]).optional(), oid: z.string().min(1).optional(), tid: z.string().min(1).optional(),
});
const jwksCache = new Map<string, { at: number; keys: z.infer<typeof jwkSchema>[] }>();
const JWKS_TTL_MS = 60 * 60 * 1000;
export const clearJwksCache = (): void => jwksCache.clear();

async function keysFor(cfg: ProviderConfig, http: FetchJson, fresh = false): Promise<z.infer<typeof jwkSchema>[]> {
  const cached = jwksCache.get(cfg.jwks);
  if (!fresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
  const body = z.object({ keys: z.array(z.unknown()).max(100) }).parse(
    await http(cfg.jwks, { method: "GET", signal: AbortSignal.timeout(SSO_TIMEOUT_MS) }));
  const keys = body.keys.flatMap(key => { const parsed = jwkSchema.safeParse(key); return parsed.success ? [parsed.data] : []; });
  jwksCache.set(cfg.jwks, { at: Date.now(), keys });
  return keys;
}

/** An RS256 ID token's claims, once its signature checks against the provider's keys. */
export async function verifyIdToken(cfg: ProviderConfig, token: string, http: FetchJson): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;
  let header: { alg: "RS256"; kid: string };
  let claims: z.infer<typeof tokenClaims>;
  try {
    header = z.object({ alg: z.literal("RS256"), kid: z.string().min(1) }).parse(JSON.parse(Buffer.from(h, "base64url").toString("utf8")));
    claims = tokenClaims.parse(JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  let jwk = (await keysFor(cfg, http)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keysFor(cfg, http, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  return ok ? claims : null;
}

/** Unicode-normalised, case-insensitive (§3.1 B step 2). */
export const sameEmail = (a: string, b: string): boolean =>
  a.normalize("NFC").trim().toLowerCase() === b.normalize("NFC").trim().toLowerCase();

export type SsoResult =
  | { ok: true; subject: string; tenant: string | null }
  | { ok: false; status: 400 | 409 | 502; reason: "no_state" | "bad_token" | "code_refused" | "email_unverified" | "email_mismatch" | "provider_unavailable" };

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
  let exchangingCode = true;
  try {
    const tokens = z.object({ id_token: z.string().min(1).max(32_768) }).parse(await http(cfg.token, {
      method: "POST", signal: AbortSignal.timeout(SSO_TIMEOUT_MS),
      body: new URLSearchParams({
        grant_type: "authorization_code", code: o.code, redirect_uri: cfg.redirectUri,
        client_id: cfg.clientId, client_secret: cfg.clientSecret, code_verifier: row.verifier ?? "",
      }),
    }));
    exchangingCode = false;
    claims = typeof tokens?.id_token === "string" ? await verifyIdToken(cfg, tokens.id_token, http) : null;
  } catch (err) {
    if (exchangingCode && err instanceof ProviderHttpError && err.status === 400 && err.oauthError === "invalid_grant") {
      console.warn(`[signup sso] ${cfg.provider} refused the code: ${err.status}`);
      return { ok: false, status: 400, reason: "code_refused" };
    }
    console.warn(`[signup sso] ${cfg.provider} unavailable: ${err instanceof ProviderHttpError ? err.status : err instanceof Error ? err.name : "error"}`);
    return { ok: false, status: 502, reason: "provider_unavailable" };
  }
  if (!claims) return { ok: false, status: 400, reason: "bad_token" };
  const now = Math.floor(Date.now() / 1000);
  const aud = claims.aud;
  const audOk = aud === cfg.clientId || (Array.isArray(aud) && aud.includes(cfg.clientId));
  const azpOk = claims.azp === undefined ? !Array.isArray(aud) || aud.length === 1 : claims.azp === cfg.clientId;
  const timeOk = (claims.nbf === undefined || (typeof claims.nbf === "number" && claims.nbf <= now + 60))
    && (claims.iat === undefined || (typeof claims.iat === "number" && claims.iat <= now + 60));
  if (!audOk || !azpOk || !timeOk || typeof claims.iss !== "string" || !cfg.issuerOk(claims.iss, claims)
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
