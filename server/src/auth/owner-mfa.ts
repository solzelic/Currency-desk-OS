/* Owner authenticator and recovery codes.
   The secret is encrypted with the same helper as a platform operator.
   Recovery codes are scrypt hashes and are returned once. A backup code
   can finish an owner sign-in. It cannot be the step-up that removes a
   method. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { TOTP, Secret } from "otpauth";
import { schema, type Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "./password.js";
import { recordSignInAttempt, releaseSignInSuccess, signInLock, type SignInDecision } from "./signin-guard.js";
import { decryptSecret, encryptSecret } from "./totp-secret.js";
import { makeCode, hashCode, codeMatches, sendEmail, loginCodeEmail } from "../email.js";
import { isEmail } from "./login-user.js";
import { audit } from "../audit.js";
import { SIGN_IN_AUDIT, signInAuditDetail } from "./signin-audit.js";

const STEP_UP_MS = 5 * 60 * 1000;
const ENROLL_MS = 10 * 60 * 1000;
const BACKUP_COUNT = 10;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalizeBackupCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]/g, "");
}

function generateBackupCode(): string {
  const bytes = randomBytes(10);
  const body = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${body.slice(0, 5)}-${body.slice(5)}`;
}

function totpFor(label: string, base32: string): TOTP {
  return new TOTP({
    issuer: "CurrencyDesk",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32),
  });
}

async function matchedStep(totp: TOTP, token: string): Promise<number | null> {
  const timestamp = Date.now();
  const delta = totp.validate({ token, timestamp, window: 1 });
  if (delta === null) return null;
  return TOTP.counter({ period: 30, timestamp }) + delta;
}

export async function stepUpFresh(db: Db, token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const row = (await db.select({ at: schema.sessions.stepUpAt }).from(schema.sessions).where(and(
    eq(schema.sessions.tokenHash, sha256(token)),
    isNull(schema.sessions.revokedAt),
    gt(schema.sessions.expiresAt, new Date(now)),
  )).limit(1))[0];
  if (!row?.at) return false;
  return now - row.at.getTime() < STEP_UP_MS;
}

export async function markStepUp(db: Db, token: string): Promise<void> {
  await db.update(schema.sessions).set({ stepUpAt: new Date() }).where(and(
    eq(schema.sessions.tokenHash, sha256(token)),
    isNull(schema.sessions.revokedAt),
  ));
}

type Staff = typeof schema.staffUsers.$inferSelect;

export async function totpEnrolled(db: Db, userId: string): Promise<boolean> {
  const row = (await db.select({ at: schema.staffTotp.enrolledAt }).from(schema.staffTotp).where(eq(schema.staffTotp.staffUserId, userId)).limit(1))[0];
  return !!row?.at;
}

/** Password re-entry, plus the authenticator when one is enrolled.
    The emailed code is checked by the caller when there is no authenticator. */
export async function passwordMatches(user: Staff, password: string): Promise<boolean> {
  if (!user.passwordHash) return false;
  return verifyPassword(password, user.passwordHash);
}

export async function issueStepUpCode(db: Db, user: Staff, sessionToken: string): Promise<{ ok: true; code: string } | { ok: false; error: "no_address" }> {
  const to = user.email && isEmail(user.email) ? user.email : isEmail(user.staffId) ? user.staffId : null;
  if (!to) return { ok: false, error: "no_address" };
  const code = makeCode();
  await db.insert(schema.authChallenges).values({
    id: `chl-${randomUUID()}`,
    tenantId: user.tenantId,
    purpose: "stepup",
    challengeHash: sha256(`${user.id}:email`),
    verifier: hashCode(code),
    provider: "email",
    staffUserId: user.id,
    sessionHash: sha256(sessionToken),
    expiresAt: new Date(Date.now() + ENROLL_MS),
  });
  const mail = loginCodeEmail(code, user.name);
  await sendEmail(to, mail.subject, { text: mail.text, html: mail.html, sensitive: true });
  return { ok: true, code };
}

export async function consumeStepUpCode(db: Db, user: Staff, sessionToken: string, code: string): Promise<boolean> {
  const row = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.tenantId, user.tenantId),
    eq(schema.authChallenges.purpose, "stepup"),
    eq(schema.authChallenges.provider, "email"),
    eq(schema.authChallenges.staffUserId, user.id),
    eq(schema.authChallenges.sessionHash, sha256(sessionToken)),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!row?.verifier || !codeMatches(code, row.verifier)) return false;
  const spent = await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(and(
    eq(schema.authChallenges.id, row.id),
    isNull(schema.authChallenges.usedAt),
  )).returning();
  return spent.length > 0;
}

export async function beginOwnerTotp(
  db: Db,
  user: Staff,
  sessionToken: string,
): Promise<{ ok: true; ticket: string; otpauthUri: string; manualSecret: string; backupCodes: string[] } | { ok: false; error: "already_enrolled" | "not_owner" }> {
  if (user.role !== "administrator") return { ok: false, error: "not_owner" };
  if (await totpEnrolled(db, user.id)) return { ok: false, error: "already_enrolled" };
  const secret = new Secret({ size: 20 });
  const totp = totpFor(user.staffId, secret.base32);
  const backupCodes = Array.from({ length: BACKUP_COUNT }, () => generateBackupCode());
  const hashes = await Promise.all(backupCodes.map((code) => hashPassword(normalizeBackupCode(code))));
  const ticket = randomBytes(32).toString("base64url");
  await db.insert(schema.authChallenges).values({
    id: `chl-${randomUUID()}`,
    tenantId: user.tenantId,
    purpose: "stepup",
    challengeHash: sha256(ticket),
    verifier: await encryptSecret(secret.base32),
    provider: "totp",
    issuer: JSON.stringify(hashes),
    staffUserId: user.id,
    sessionHash: sha256(sessionToken),
    expiresAt: new Date(Date.now() + ENROLL_MS),
  });
  return { ok: true, ticket, otpauthUri: totp.toString(), manualSecret: secret.base32, backupCodes };
}

const FACTOR_MAX = 5;

export type FactorFailure =
  | { ok: false; error: "wrong_code" }
  | { ok: false; error: "locked"; locked: Extract<SignInDecision, { result: "locked" }> };

function stricterLock(left: SignInDecision | null, right: SignInDecision | null): Extract<SignInDecision, { result: "locked" }> | null {
  const a = left?.result === "locked" ? left : null;
  const b = right?.result === "locked" ? right : null;
  if (!a) return b;
  if (!b) return a;
  return a.retryAfter >= b.retryAfter ? a : b;
}

/** Five wrong factor attempts per 15 minutes, for the staff member and the address. */
export async function noteFactorAttempt(
  db: Db,
  user: Staff,
  ip: string,
  matched: boolean,
  method: string,
): Promise<{ ok: true } | Extract<FactorFailure, { error: "locked" }>> {
  const staffKey = `factor:${user.id}`;
  const ipKey = `factor-ip:${ip}`;
  const staffAttempt = await recordSignInAttempt(db, staffKey);
  const ipAttempt = await recordSignInAttempt(db, ipKey);
  const locked = stricterLock(
    signInLock(staffAttempt, FACTOR_MAX, "account", matched),
    signInLock(ipAttempt, FACTOR_MAX, "ip", matched),
  );
  if (!matched || locked) {
    await audit(db, {
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      branchId: user.branchId,
      actorId: user.id,
      action: locked ? SIGN_IN_AUDIT.loginLocked : SIGN_IN_AUDIT.loginFailed,
      detail: signInAuditDetail({ method, result: "fail", staffId: user.staffId, shop: user.tenantId, ip }),
    });
  }
  if (locked) return { ok: false, error: "locked", locked };
  if (matched) await releaseSignInSuccess(db, staffKey, staffAttempt.failures, ipKey);
  return { ok: true };
}

export async function authenticatorPresent(db: Db, userId: string, tenantId: string): Promise<boolean> {
  if (await totpEnrolled(db, userId)) return true;
  const key = (await db.select({ id: schema.staffPasskeys.id }).from(schema.staffPasskeys).where(and(
    eq(schema.staffPasskeys.tenantId, tenantId),
    eq(schema.staffPasskeys.staffUserId, userId),
    isNull(schema.staffPasskeys.revokedAt),
  )).limit(1))[0];
  return !!key;
}

export async function confirmOwnerTotp(
  db: Db,
  user: Staff,
  sessionToken: string,
  ticket: string,
  code: string,
  ip: string,
): Promise<true | FactorFailure | { ok: false; error: "already_enrolled" | "bad_ticket" }> {
  if (await totpEnrolled(db, user.id)) return { ok: false, error: "already_enrolled" };
  const row = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.tenantId, user.tenantId),
    eq(schema.authChallenges.purpose, "stepup"),
    eq(schema.authChallenges.provider, "totp"),
    eq(schema.authChallenges.challengeHash, sha256(ticket)),
    eq(schema.authChallenges.staffUserId, user.id),
    eq(schema.authChallenges.sessionHash, sha256(sessionToken)),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!row?.verifier || !/^\d{6}$/.test(code.trim())) {
    const gate = await noteFactorAttempt(db, user, ip, false, "totp");
    return gate.ok ? { ok: false, error: "bad_ticket" } : gate;
  }
  let base32: string;
  try {
    base32 = await decryptSecret(row.verifier);
  } catch {
    const gate = await noteFactorAttempt(db, user, ip, false, "totp");
    return gate.ok ? { ok: false, error: "bad_ticket" } : gate;
  }
  const step = await matchedStep(totpFor(user.staffId, base32), code.trim());
  if (step === null) {
    const gate = await noteFactorAttempt(db, user, ip, false, "totp");
    return gate.ok ? { ok: false, error: "bad_ticket" } : gate;
  }
  const hashes = JSON.parse(row.issuer || "[]") as unknown;
  if (!Array.isArray(hashes) || hashes.some((item) => typeof item !== "string")) return { ok: false, error: "bad_ticket" };
  const wrote = await db.insert(schema.staffTotp).values({
    staffUserId: user.id,
    tenantId: user.tenantId,
    secretEnc: row.verifier,
    enrolledAt: new Date(),
    lastStep: step,
  }).onConflictDoNothing().returning();
  if (!wrote.length) return { ok: false, error: "already_enrolled" };
  await db.delete(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.tenantId, user.tenantId),
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
  ));
  if (hashes.length) {
    await db.insert(schema.staffRecoveryCodes).values(hashes.map((codeHash) => ({
      id: `rcv-${randomUUID()}`,
      tenantId: user.tenantId,
      staffUserId: user.id,
      codeHash: codeHash as string,
    })));
  }
  await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(and(
    eq(schema.authChallenges.tenantId, user.tenantId),
    eq(schema.authChallenges.staffUserId, user.id),
    eq(schema.authChallenges.provider, "totp"),
    isNull(schema.authChallenges.usedAt),
  ));
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.recoveryIssued,
    detail: signInAuditDetail({ method: "totp", result: "enrolled", staffId: user.staffId, shop: user.tenantId }),
  });
  return true;
}

async function matchOwnerFactor(db: Db, user: Staff, code: string): Promise<"totp" | "backup" | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const row = (await db.select().from(schema.staffTotp).where(and(
      eq(schema.staffTotp.tenantId, user.tenantId),
      eq(schema.staffTotp.staffUserId, user.id),
    )).limit(1))[0];
    if (!row?.enrolledAt) return null;
    let base32: string;
    try {
      base32 = await decryptSecret(row.secretEnc);
    } catch {
      return null;
    }
    const step = await matchedStep(totpFor(user.staffId, base32), trimmed);
    if (step === null || (row.lastStep != null && step <= row.lastStep)) return null;
    return "totp";
  }
  const normalized = normalizeBackupCode(trimmed);
  if (normalized.length < 8) return null;
  const codes = await db.select().from(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.tenantId, user.tenantId),
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
    isNull(schema.staffRecoveryCodes.usedAt),
  ));
  for (const row of codes) {
    if (await verifyPassword(normalized, row.codeHash)) return "backup";
  }
  return null;
}

async function consumeOwnerFactor(db: Db, user: Staff, code: string, factor: "totp" | "backup"): Promise<boolean> {
  if (factor === "totp") {
    if ((await matchOwnerFactor(db, user, code)) !== "totp") return false;
    const row = (await db.select().from(schema.staffTotp).where(and(
      eq(schema.staffTotp.tenantId, user.tenantId),
      eq(schema.staffTotp.staffUserId, user.id),
    )).limit(1))[0];
    if (!row?.enrolledAt) return false;
    let base32: string;
    try {
      base32 = await decryptSecret(row.secretEnc);
    } catch {
      return false;
    }
    const step = await matchedStep(totpFor(user.staffId, base32), code.trim());
    if (step === null) return false;
    const wrote = await db.update(schema.staffTotp).set({ lastStep: step }).where(and(
      eq(schema.staffTotp.staffUserId, user.id),
      eq(schema.staffTotp.tenantId, user.tenantId),
      row.lastStep == null ? isNull(schema.staffTotp.lastStep) : eq(schema.staffTotp.lastStep, row.lastStep),
    )).returning();
    return wrote.length === 1;
  }
  const normalized = normalizeBackupCode(code);
  const codes = await db.select().from(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.tenantId, user.tenantId),
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
    isNull(schema.staffRecoveryCodes.usedAt),
  ));
  for (const row of codes) {
    if (!(await verifyPassword(normalized, row.codeHash))) continue;
    const spent = await db.update(schema.staffRecoveryCodes).set({ usedAt: new Date() }).where(and(
      eq(schema.staffRecoveryCodes.id, row.id),
      eq(schema.staffRecoveryCodes.tenantId, user.tenantId),
      isNull(schema.staffRecoveryCodes.usedAt),
    )).returning();
    if (!spent.length) return false;
    await audit(db, {
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      branchId: user.branchId,
      actorId: user.id,
      action: SIGN_IN_AUDIT.recoveryUsed,
      detail: signInAuditDetail({ method: "backup", result: "ok", staffId: user.staffId, shop: user.tenantId }),
    });
    return true;
  }
  return false;
}

/** Failures still inside the 15-minute window. An expired window is zero. */
async function freshFailures(db: Db, bucket: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT failures FROM signin_failures
    WHERE bucket = ${bucket}
      AND window_started_at > now() - interval '15 minutes'
  `);
  const row = result.rows[0] as { failures?: number | string } | undefined;
  return row?.failures === undefined ? 0 : Number(row.failures);
}

/** TOTP or one backup code, with the shared wrong-code limit.
    A used backup code does not work again. The same TOTP step does not work twice.
    A caller who is already locked does not reach scrypt. */
export async function verifyOwnerFactor(
  db: Db,
  user: Staff,
  code: string,
  ip: string,
): Promise<{ ok: true; factor: "totp" | "backup" } | FactorFailure> {
  const [staffFailures, ipFailures] = await Promise.all([
    freshFailures(db, `factor:${user.id}`),
    freshFailures(db, `factor-ip:${ip}`),
  ]);
  if (staffFailures >= FACTOR_MAX || ipFailures >= FACTOR_MAX) {
    const locked = await noteFactorAttempt(db, user, ip, false, "code");
    return locked.ok ? { ok: false, error: "wrong_code" } : locked;
  }
  const factor = await matchOwnerFactor(db, user, code);
  const gate = await noteFactorAttempt(db, user, ip, factor !== null, factor ?? "code");
  if (!gate.ok) return gate;
  if (!factor) return { ok: false, error: "wrong_code" };
  if (!(await consumeOwnerFactor(db, user, code, factor))) return { ok: false, error: "wrong_code" };
  return { ok: true, factor };
}

export async function regenerateRecoveryCodes(db: Db, user: Staff): Promise<string[] | null> {
  if (user.role !== "administrator" || !(await totpEnrolled(db, user.id))) return null;
  const backupCodes = Array.from({ length: BACKUP_COUNT }, () => generateBackupCode());
  const hashes = await Promise.all(backupCodes.map((code) => hashPassword(normalizeBackupCode(code))));
  await db.delete(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.tenantId, user.tenantId),
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
  ));
  await db.insert(schema.staffRecoveryCodes).values(hashes.map((codeHash) => ({
    id: `rcv-${randomUUID()}`,
    tenantId: user.tenantId,
    staffUserId: user.id,
    codeHash,
  })));
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: user.id,
    action: SIGN_IN_AUDIT.recoveryIssued,
    detail: signInAuditDetail({ method: "backup", result: "replaced", staffId: user.staffId, shop: user.tenantId }),
  });
  return backupCodes;
}
