/* ============================================================
   Sign-up v2.1: "Check your inbox" and the enrolment session
   (SIGNUP-LOGIC §3.2, §6, §10).

   The code goes to the email the owner applied with (the reservation's,
   never an address typed here) the moment a credential is saved. Six
   digits, 10 minutes, 5 tries, one active code (a new one replaces the
   last), 3 sends per 15 minutes. Only its SHA-256 is stored and it is
   compared in constant time (email.ts, shared with every other code).

   Passing it, in the browser that saved a candidate credential:
     - that browser's credential becomes the verified one, and every other
       candidate is dropped;
     - the account moves enrolling → verified;
     - an enrolment session is issued: chapters 2 to 5 for this one
       reservation, 24 hours sliding, never the desk API.

   All of that is one transaction, and the code is spent by a guarded
   UPDATE, so two right answers at once cannot both pass.
   ============================================================ */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { schema, type Db } from "../db/index.js";
import { codeMatches, hashCode, makeCode, sendEmail, type EmailStatus } from "../email.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { CODE_TTL_MS, MAX_CODE_ATTEMPTS } from "./verify.js";
import { sha256, withSignupAccount, signupReservationMatches } from "./signup-account.js";

export const SENDS_PER_WINDOW = 3;
export const SEND_WINDOW_MS = 15 * 60 * 1000;
export const ENROLMENT_COOKIE = "cd_enrol";
export const ENROLMENT_TTL_MS = 24 * 60 * 60 * 1000;

type Enquiry = typeof schema.enquiries.$inferSelect;

export type Mailer = (to: string, subject: string, body: { text: string; html: string; sensitive?: boolean }) => Promise<EmailStatus>;

export function signupCodeEmail(code: string, operatingName: string) {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const subject = "Your CurrencyDesk code";
  const text = `Your code for ${operatingName} is ${code}.\n\nIt works for 10 minutes. Type it on the screen that asked for it.\n\nDidn't ask for this? You can ignore it; nothing opens without the code.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#17140F">` +
    `<p style="font-size:15px;line-height:1.6">Your code for ${esc(operatingName)}:</p>` +
    `<div style="font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:30px;font-weight:700;letter-spacing:.3em;margin:20px 0;padding:16px 0;text-align:center;background:#F6F1E7;border-radius:12px">${code}</div>` +
    `<p style="font-size:13px;color:#6E675E;line-height:1.6">It works for 10 minutes. Didn't ask for this? You can ignore it; nothing opens without the code.</p></div>`;
  return { subject, text, html };
}

export type SendResult = { sent: true; delivery: EmailStatus } | { sent: false; reason: "too_soon"; retryInMs: number } | { sent: false; reason: "not_enrolling" };

/** Issue a fresh code (replacing any other) and send it to the email on file. */
export async function sendSignupCode(db: Db, row: Enquiry, operatingName: string, mail: Mailer = sendEmail, now = Date.now()): Promise<SendResult> {
  const prepared = await withSignupAccount(db, row.id, async (tx, account) => {
    if (account.state !== "enrolling" || (row.cdId && !(await signupReservationMatches(tx, row.id, row.cdId)))) return { sent: false, reason: "not_enrolling" } as const;
    const recent = (account.codeSends ?? []).filter((t) => now - t < SEND_WINDOW_MS);
    if (recent.length >= SENDS_PER_WINDOW) {
      return { sent: false, reason: "too_soon", retryInMs: SEND_WINDOW_MS - (now - Math.min(...recent)) } as const;
    }
    const code = makeCode();
    await tx.update(schema.signupAccounts).set({
      codeHash: hashCode(code), codeExpiresAt: new Date(now + CODE_TTL_MS), codeAttempts: 0,
      codeSends: [...recent, now], updatedAt: new Date(now),
    }).where(eq(schema.signupAccounts.enquiryId, row.id));
    return { sent: true, code } as const;
  });
  if (!prepared.sent) return prepared;
  const code = prepared.code;
  const message = signupCodeEmail(code, operatingName);
  const delivery = await mail(row.email, message.subject, { text: message.text, html: message.html, sensitive: true });
  return { sent: true, delivery };
}

export type VerifyResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; status: 400 | 401 | 409 | 410 | 423; error: "no_candidate" | "no_code" | "wrong_code" | "expired" | "too_many_attempts" | "not_enrolling" };

export async function verifySignupCode(db: Db, enquiryId: string, attemptHash: string, entered: string, now = Date.now(), expectedCdId?: string): Promise<VerifyResult> {
  return withSignupAccount(db, enquiryId, async (db, account): Promise<VerifyResult> => {
  if (expectedCdId && !(await signupReservationMatches(db, enquiryId, expectedCdId))) return { ok: false, status: 409, error: "not_enrolling" };
  if (!account || account.state !== "enrolling") return { ok: false, status: 409, error: "not_enrolling" };
  const candidate = (await db.select().from(schema.signupCredentials).where(and(
    eq(schema.signupCredentials.enquiryId, enquiryId), eq(schema.signupCredentials.attemptHash, attemptHash), isNull(schema.signupCredentials.verifiedAt),
  )).limit(1))[0];
  if (!candidate) return { ok: false, status: 400, error: "no_candidate" };
  if (!account.codeHash) return { ok: false, status: 409, error: "no_code" };
  if (account.codeAttempts >= MAX_CODE_ATTEMPTS) return { ok: false, status: 423, error: "too_many_attempts" };
  if (!account.codeExpiresAt || account.codeExpiresAt.getTime() <= now) return { ok: false, status: 410, error: "expired" };
  if (!/^\d{6}$/.test(entered.trim()) || !codeMatches(entered, account.codeHash)) {
    const tries = account.codeAttempts + 1;
    await db.update(schema.signupAccounts).set({
      codeAttempts: tries, ...(tries >= MAX_CODE_ATTEMPTS ? { codeHash: null } : {}),
    }).where(and(eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.codeHash, account.codeHash)));
    return tries >= MAX_CODE_ATTEMPTS
      ? { ok: false, status: 423, error: "too_many_attempts" }
      : { ok: false, status: 401, error: "wrong_code" };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + ENROLMENT_TTL_MS);
  const tx = db;
  {
    const spent = await tx.update(schema.signupAccounts).set({
      codeHash: null, codeExpiresAt: null, codeAttempts: 0, emailVerifiedAt: new Date(now), state: "verified", updatedAt: new Date(now),
    }).where(and(
      eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.codeHash, account.codeHash), eq(schema.signupAccounts.state, "enrolling"),
    )).returning();
    if (!spent.length) return { ok: false, status: 409, error: "not_enrolling" };
    await tx.update(schema.signupCredentials).set({ verifiedAt: new Date(now) }).where(eq(schema.signupCredentials.id, candidate.id));
    await tx.delete(schema.signupCredentials).where(and(
      eq(schema.signupCredentials.enquiryId, enquiryId), isNull(schema.signupCredentials.verifiedAt), ne(schema.signupCredentials.id, candidate.id),
    ));
    await tx.insert(schema.enrolmentSessions).values({ tokenHash: sha256(token), enquiryId, expiresAt });
  }
  await audit(db, {
    tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-",
    action: "signup.email_verified", detail: { enquiryId, credential: candidate.id, kind: candidate.kind },
  });
  return { ok: true, token, expiresAt };
  });
}

export function setEnrolmentCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ENROLMENT_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/api/onboarding", maxAge: ENROLMENT_TTL_MS / 1000,
  });
}

/* The enrolment session this request carries, for THIS reservation only.
   Slides the 24 hours forward on every use. Null when there is none, it
   has lapsed, it was revoked, or it belongs to another reservation. */
export async function enrolmentFor(db: Db, req: FastifyRequest, reply: FastifyReply, enquiryId: string, now = Date.now()): Promise<{ enquiryId: string } | null> {
  const token = req.cookies?.[ENROLMENT_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = sha256(token);
  const slid = await db.update(schema.enrolmentSessions)
    .set({ lastSeenAt: new Date(now), expiresAt: new Date(now + ENROLMENT_TTL_MS) })
    .where(and(
      eq(schema.enrolmentSessions.tokenHash, hash), eq(schema.enrolmentSessions.enquiryId, enquiryId),
      isNull(schema.enrolmentSessions.revokedAt), gt(schema.enrolmentSessions.expiresAt, new Date(now)),
    )).returning();
  if (!slid.length) return null;
  setEnrolmentCookie(reply, token);
  return { enquiryId };
}

/** d••••@yorkcurrency.ca */
export const maskEmail = (email: string): string => {
  const [user, domain] = email.split("@");
  return user && domain ? `${user[0]}••••@${domain}` : "••••";
};
/** +1 416 ••• 0142 style: everything but the last four digits hidden. */
export const maskPhone = (phone: string): string => {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 4 ? `••• ${digits.slice(-4)}` : "";
};
