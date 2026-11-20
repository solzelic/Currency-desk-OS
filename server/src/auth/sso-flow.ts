/* Desk Google and Microsoft sign-in and linking.
   An identity provider account resolves a staff row that is already
   linked. It never creates a staff row, a tenant, or a shop. Access
   and refresh tokens are not stored. The demo shop is never linked. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { completeSignIn, type DeskSignInMethod } from "./complete-sign-in.js";
import { SIGN_IN_AUDIT, signInAuditDetail } from "./signin-audit.js";
import { ownerSecondStepReady, listSignInMethods, removalBlocked } from "./methods.js";
import { revokeAllSessions } from "./sessions.js";
import { sendIdentityMail } from "./signin-mail.js";
import {
  allowReturnTo,
  fetchJson,
  identityFromClaims,
  signInProviderConfig,
  verifySignInIdToken,
  type FetchJson,
  type Provider,
  type ProviderConfig,
  type SignInIdentity,
  type SsoPurpose,
} from "./oidc.js";
import { CHALLENGE_TTL_MS } from "./webauthn.js";

const DEMO_TENANT = "tnt-yorkfx";
const b64url = (buf: Buffer): string => buf.toString("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let ssoHttp: FetchJson = fetchJson;

/** Tests replace the provider HTTP client. Production ignores this. */
export function setSsoHttp(next: FetchJson | null): void {
  if (process.env.NODE_ENV === "production") return;
  ssoHttp = next ?? fetchJson;
}

export function ssoConfig(provider: Provider, purpose: SsoPurpose, env: NodeJS.ProcessEnv = process.env): ProviderConfig | null {
  return signInProviderConfig(provider, purpose, env);
}

export async function beginSso(
  db: Db,
  cfg: ProviderConfig,
  purpose: SsoPurpose,
  opts: { returnTo?: unknown; staffUserId?: string | null; sessionToken?: string | null },
): Promise<string> {
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16));
  await db.insert(schema.authChallenges).values({
    id: `chl-${randomUUID()}`,
    purpose: purpose === "link" ? "oidc_link" : "oidc_signin",
    challengeHash: sha256(state),
    nonce,
    verifier,
    provider: cfg.provider,
    returnTo: allowReturnTo(opts.returnTo),
    staffUserId: opts.staffUserId ?? null,
    sessionHash: opts.sessionToken ? sha256(opts.sessionToken) : null,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
    nonce,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  return `${cfg.authorize}?${q.toString()}`;
}

export type CallbackResult =
  | { ok: true; kind: "session"; token: string; expiresAt: Date; returnTo: string }
  | { ok: true; kind: "confirm" | "shops"; pending: string; returnTo: string }
  | { ok: true; kind: "linked"; returnTo: string }
  | { ok: false; reason: "no_state" | "refused" | "provider" };

async function spend(db: Db, purpose: "oidc_signin" | "oidc_link", provider: Provider, state: string) {
  const row = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.purpose, purpose),
    eq(schema.authChallenges.provider, provider),
    eq(schema.authChallenges.challengeHash, sha256(state)),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!row) return null;
  const spent = await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(and(
    eq(schema.authChallenges.id, row.id),
    isNull(schema.authChallenges.usedAt),
  )).returning();
  return spent[0] ?? null;
}

async function identityFromCode(cfg: ProviderConfig, code: string, verifier: string, nonce: string): Promise<SignInIdentity | null> {
  const tokens = z.object({ id_token: z.string().min(1).max(32_768) }).parse(await ssoHttp(cfg.token, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: verifier,
    }),
  }));
  const claims = await verifySignInIdToken(cfg, tokens.id_token, nonce, ssoHttp);
  if (!claims) return null;
  return identityFromClaims(cfg, claims);
}

export async function linkedStaff(db: Db, identity: SignInIdentity) {
  const rows = await db.select().from(schema.staffIdentities).where(and(
    eq(schema.staffIdentities.provider, identity.provider),
    eq(schema.staffIdentities.subject, identity.subject),
    identity.provider === "microsoft" && identity.msTid
      ? eq(schema.staffIdentities.msTid, identity.msTid)
      : eq(schema.staffIdentities.issuer, identity.issuer),
  ));
  const people = [];
  for (const row of rows) {
    if (row.tenantId === DEMO_TENANT) continue;
    if (identity.provider === "microsoft" && !(await microsoftTenantAllowed(db, row.tenantId, identity.msTid))) continue;
    const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, row.staffUserId)).limit(1))[0];
    if (!user || !user.active) continue;
    people.push(user);
  }
  return people;
}

/** Null allowlist means the shop has not turned it on. */
export async function microsoftTenantAllowed(db: Db, tenantId: string, tid: string | null): Promise<boolean> {
  if (!tid) return false;
  const row = (await db.select({ list: schema.tenants.msTenantAllowlist }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  if (row?.list == null) return true;
  return Array.isArray(row.list) && row.list.includes(tid);
}

async function pending(db: Db, identity: SignInIdentity, staffUserId: string | null, returnTo: string): Promise<string> {
  const token = b64url(randomBytes(32));
  await db.insert(schema.authChallenges).values({
    id: `chl-${randomUUID()}`,
    purpose: "oidc_signin",
    challengeHash: sha256(token),
    provider: identity.provider,
    issuer: identity.issuer,
    subject: identity.subject,
    msTid: identity.msTid,
    staffUserId,
    returnTo,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return token;
}

export async function finishSignInCallback(
  db: Db,
  cfg: ProviderConfig,
  code: string,
  state: string,
  ip: string,
): Promise<CallbackResult> {
  const row = await spend(db, "oidc_signin", cfg.provider, state);
  if (!row) return { ok: false, reason: "no_state" };
  if (!row.verifier || !row.nonce) return { ok: false, reason: "refused" };
  let identity: SignInIdentity | null = null;
  try {
    identity = await identityFromCode(cfg, code, row.verifier, row.nonce);
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (!identity) return { ok: false, reason: "refused" };
  const people = await linkedStaff(db, identity);
  const returnTo = allowReturnTo(row.returnTo);
  if (people.length === 0) return { ok: false, reason: "refused" };
  if (people.length > 1) {
    const token = await pending(db, identity, null, returnTo);
    return { ok: true, kind: "shops", pending: token, returnTo };
  }
  const user = people[0]!;
  if (user.role === "administrator" && !(await ownerSecondStepReady(db, user))) {
    return { ok: false, reason: "refused" };
  }
  if (user.role === "administrator") {
    const token = await pending(db, identity, user.id, returnTo);
    return { ok: true, kind: "confirm", pending: token, returnTo };
  }
  const done = await completeSignIn(db, user, cfg.provider as DeskSignInMethod, { ip, issuer: identity.issuer });
  if (!done.ok) return { ok: false, reason: "refused" };
  await db.update(schema.staffIdentities).set({ lastUsedAt: new Date() }).where(and(
    eq(schema.staffIdentities.staffUserId, user.id),
    eq(schema.staffIdentities.provider, identity.provider),
    eq(schema.staffIdentities.subject, identity.subject),
  ));
  return { ok: true, kind: "session", token: done.token, expiresAt: done.expiresAt, returnTo };
}

export async function shopsForPending(db: Db, pendingToken: string) {
  const row = await loadPending(db, pendingToken);
  if (!row || row.staffUserId) return null;
  const identity: SignInIdentity = {
    provider: row.provider as Provider,
    issuer: row.issuer || "",
    subject: row.subject || "",
    msTid: row.msTid,
  };
  const people = await linkedStaff(db, identity);
  const shops = [];
  for (const user of people) {
    const name = (await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, user.tenantId)).limit(1))[0]?.name ?? "Desk";
    shops.push({ staffUserId: user.id, name });
  }
  return shops;
}

async function loadPending(db: Db, token: string) {
  return (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.purpose, "oidc_signin"),
    eq(schema.authChallenges.challengeHash, sha256(token)),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0] ?? null;
}

export async function pickShop(db: Db, pendingToken: string, staffUserId: string, ip: string): Promise<CallbackResult> {
  const row = await loadPending(db, pendingToken);
  if (!row?.provider || !row.subject) return { ok: false, reason: "refused" };
  const identity: SignInIdentity = {
    provider: row.provider as Provider,
    issuer: row.issuer || "",
    subject: row.subject,
    msTid: row.msTid,
  };
  const people = await linkedStaff(db, identity);
  const user = people.find((person) => person.id === staffUserId);
  if (!user) return { ok: false, reason: "refused" };
  await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(eq(schema.authChallenges.id, row.id));
  const returnTo = allowReturnTo(row.returnTo);
  if (user.role === "administrator") {
    if (!(await ownerSecondStepReady(db, user))) return { ok: false, reason: "refused" };
    const token = await pending(db, identity, user.id, returnTo);
    return { ok: true, kind: "confirm", pending: token, returnTo };
  }
  const done = await completeSignIn(db, user, identity.provider as DeskSignInMethod, { ip, issuer: identity.issuer });
  if (!done.ok) return { ok: false, reason: "refused" };
  return { ok: true, kind: "session", token: done.token, expiresAt: done.expiresAt, returnTo };
}

export async function confirmOwner(db: Db, pendingToken: string, code: string, ip: string): Promise<CallbackResult> {
  const row = await loadPending(db, pendingToken);
  if (!row?.staffUserId || !row.provider) return { ok: false, reason: "refused" };
  const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, row.staffUserId)).limit(1))[0];
  if (!user || user.role !== "administrator" || !(await ownerSecondStepReady(db, user))) return { ok: false, reason: "refused" };
  const { verifyOwnerFactor } = await import("./owner-mfa.js");
  const factor = await verifyOwnerFactor(db, user, code);
  if (!factor) return { ok: false, reason: "refused" };
  await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(and(
    eq(schema.authChallenges.id, row.id),
    isNull(schema.authChallenges.usedAt),
  ));
  const done = await completeSignIn(db, user, row.provider as DeskSignInMethod, { ip, issuer: row.issuer });
  if (!done.ok) return { ok: false, reason: "refused" };
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.login,
    detail: signInAuditDetail({ method: factor, result: "owner_second_step", issuer: row.issuer ?? undefined, staffId: user.staffId, shop: user.tenantId, ip }),
  });
  return { ok: true, kind: "session", token: done.token, expiresAt: done.expiresAt, returnTo: allowReturnTo(row.returnTo) };
}

export async function finishLinkCallback(
  db: Db,
  cfg: ProviderConfig,
  code: string,
  state: string,
  sessionToken: string | undefined,
): Promise<CallbackResult> {
  const row = await spend(db, "oidc_link", cfg.provider, state);
  if (!row) return { ok: false, reason: "no_state" };
  if (!row.verifier || !row.nonce || !row.staffUserId || !row.sessionHash) return { ok: false, reason: "refused" };
  if (!sessionToken || sha256(sessionToken) !== row.sessionHash) return { ok: false, reason: "refused" };
  let identity: SignInIdentity | null = null;
  try {
    identity = await identityFromCode(cfg, code, row.verifier, row.nonce);
  } catch {
    return { ok: false, reason: "provider" };
  }
  if (!identity) return { ok: false, reason: "refused" };
  const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, row.staffUserId)).limit(1))[0];
  if (!user || !user.active || user.tenantId === DEMO_TENANT) return { ok: false, reason: "refused" };
  if (identity.provider === "microsoft" && !(await microsoftTenantAllowed(db, user.tenantId, identity.msTid))) {
    return { ok: false, reason: "refused" };
  }
  const others = await db.select().from(schema.staffIdentities).where(and(
    eq(schema.staffIdentities.provider, identity.provider),
    eq(schema.staffIdentities.subject, identity.subject),
    eq(schema.staffIdentities.tenantId, user.tenantId),
  ));
  if (others.some((item) => item.staffUserId !== user.id)) return { ok: false, reason: "refused" };
  if (!others.some((item) => item.staffUserId === user.id)) {
    await db.insert(schema.staffIdentities).values({
      id: `idn-${randomUUID()}`,
      tenantId: user.tenantId,
      staffUserId: user.id,
      provider: identity.provider,
      issuer: identity.issuer,
      subject: identity.subject,
      msTid: identity.msTid,
      createdBy: user.id,
    });
  }
  const label = identity.provider === "google" ? "Google" : "Microsoft";
  const emailed = await sendIdentityMail(db, user, "linked", label);
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.linked,
    detail: signInAuditDetail({ method: identity.provider, issuer: identity.issuer, result: "ok", staffId: user.staffId, shop: user.tenantId, emailed }),
  });
  return { ok: true, kind: "linked", returnTo: "/app" };
}

export async function unlinkIdentity(db: Db, userId: string, provider: Provider): Promise<"ok" | "last_method" | "missing"> {
  const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, userId)).limit(1))[0];
  if (!user || user.tenantId === DEMO_TENANT) return "missing";
  const methods = await listSignInMethods(db, user.id, user.passwordHash);
  if (removalBlocked(methods, provider)) return "last_method";
  const existing = await db.select().from(schema.staffIdentities).where(and(
    eq(schema.staffIdentities.staffUserId, user.id),
    eq(schema.staffIdentities.provider, provider),
  ));
  if (!existing.length) return "missing";
  await db.delete(schema.staffIdentities).where(and(
    eq(schema.staffIdentities.staffUserId, user.id),
    eq(schema.staffIdentities.provider, provider),
  ));
  await revokeAllSessions(db, user.id);
  const label = provider === "google" ? "Google" : "Microsoft";
  const emailed = await sendIdentityMail(db, user, "unlinked", label);
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.unlinked,
    detail: signInAuditDetail({ method: provider, issuer: existing[0]?.issuer, result: "ok", staffId: user.staffId, shop: user.tenantId, emailed }),
  });
  return "ok";
}
