/* ============================================================
   Sign-up v2.1: the owner's account before the desk exists
   (SIGNUP-LOGIC §3, §10).

     reserved ──credential saved──▶ enrolling ──email code──▶ verified
                                               ──payment webhook──▶ active

   Every move is a guarded UPDATE (`WHERE state IN (...)`), so two requests
   racing cannot both move it, and a move the table below does not allow
   cannot be written at all.

   THE ATTEMPT. Choosing a credential needs only the ID, which is not a
   secret. So a credential saved before the email code is only a candidate,
   tied to the browser that saved it by an httpOnly cookie (stored as a
   SHA-256). The email code, entered in that same browser, is what makes
   that browser's credential the owner's (PR 3). Somebody who only knows
   the ID can add a candidate, never a verified credential.
   ============================================================ */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { schema, type Db } from "../db/index.js";
import type { CredentialKind, SignupState } from "../db/schema.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";

export const ATTEMPT_COOKIE = "cd_enrol_attempt";
const ATTEMPT_TTL_S = 24 * 60 * 60;

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The state a move leaves from, for each state it may arrive at. */
export function allowedFrom(to: SignupState): readonly SignupState[] {
  switch (to) {
    case "reserved": return ["reserved", "enrolling", "verified"]; // the idle reset (§14 Q7, not built)
    case "enrolling": return ["reserved", "enrolling"];
    case "verified": return ["enrolling"];
    case "active": return ["verified"];
  }
}

export type Account = typeof schema.signupAccounts.$inferSelect;

export async function loadAccount(db: Db, enquiryId: string): Promise<Account> {
  const found = (await db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, enquiryId)).limit(1))[0];
  if (found) return found;
  await db.insert(schema.signupAccounts).values({ enquiryId, accountId: randomUUID() }).onConflictDoNothing();
  return (await db.select().from(schema.signupAccounts).where(eq(schema.signupAccounts.enquiryId, enquiryId)).limit(1))[0]!;
}

/** Move the account, only from a state the table allows. True when it moved. */
export async function advance(db: Db, enquiryId: string, to: SignupState): Promise<boolean> {
  const moved = await db
    .update(schema.signupAccounts)
    .set({ state: to, updatedAt: new Date() })
    .where(and(eq(schema.signupAccounts.enquiryId, enquiryId), inArray(schema.signupAccounts.state, [...allowedFrom(to)])))
    .returning();
  return moved.length > 0;
}

/** The browser's attempt token, issuing one when it has none. Returns its hash. */
export function attemptOf(req: FastifyRequest, reply: FastifyReply): string {
  const existing = req.cookies?.[ATTEMPT_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return sha256(existing);
  const token = randomBytes(32).toString("base64url");
  reply.setCookie(ATTEMPT_COOKIE, token, {
    httpOnly: true,
    /* Lax, not Strict: Google and Microsoft send the phone back here by a
       top-level redirect, which a Strict cookie would not survive. */
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/onboarding",
    maxAge: ATTEMPT_TTL_S,
  });
  return sha256(token);
}

/** The hash of the attempt this browser already holds, or null. Never issues one. */
export function existingAttempt(req: FastifyRequest): string | null {
  const existing = req.cookies?.[ATTEMPT_COOKIE];
  return existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? sha256(existing) : null;
}

export type NewCredential = {
  kind: CredentialKind;
  attemptHash: string;
  passkey?: {
    id: string; publicKey: string; signCount: number; transports: string[];
    aaguid: string; backupEligible: boolean; backupState: boolean; deviceLabel: string;
  };
  sso?: { subject: string; tenant: string | null };
  passwordHash?: string;
};

/* Save a candidate credential and move reserved → enrolling. The caller has
   already checked the account is not past enrolling. */
export async function saveCredential(db: Db, enquiryId: string, c: NewCredential): Promise<{ id: string; state: SignupState }> {
  const id = `cred-${randomUUID()}`;
  await db.insert(schema.signupCredentials).values({
    id, enquiryId, kind: c.kind, attemptHash: c.attemptHash,
    ...(c.passkey ? {
      passkeyId: c.passkey.id, publicKey: c.passkey.publicKey, signCount: c.passkey.signCount,
      transports: c.passkey.transports, aaguid: c.passkey.aaguid, backupEligible: c.passkey.backupEligible,
      backupState: c.passkey.backupState, deviceLabel: c.passkey.deviceLabel,
    } : {}),
    ...(c.sso ? { ssoSubject: c.sso.subject, ssoTenant: c.sso.tenant } : {}),
    ...(c.passwordHash ? { passwordHash: c.passwordHash } : {}),
  });
  await advance(db, enquiryId, "enrolling");
  await audit(db, {
    tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-",
    action: "credential.added", detail: { enquiryId, kind: c.kind, credential: id, verified: false },
  });
  const account = await loadAccount(db, enquiryId);
  return { id, state: account.state };
}

/** A reservation's account may take a new candidate credential only before the code. */
export const takesCredential = (state: SignupState): boolean => state === "reserved" || state === "enrolling";
