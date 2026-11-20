/* Owner authenticator and recovery codes.
   The secret is encrypted with the same helper as a platform operator.
   Recovery codes are scrypt hashes and are returned once. A backup code
   can finish an owner sign-in. It cannot be the step-up that removes a
   method. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { TOTP, Secret } from "otpauth";
import { schema, type Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "./password.js";
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

export async function consumeStepUpCode(db: Db, userId: string, sessionToken: string, code: string): Promise<boolean> {
  const row = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.purpose, "stepup"),
    eq(schema.authChallenges.provider, "email"),
    eq(schema.authChallenges.staffUserId, userId),
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

export async function confirmOwnerTotp(db: Db, user: Staff, sessionToken: string, ticket: string, code: string): Promise<boolean> {
  const row = (await db.select().from(schema.authChallenges).where(and(
    eq(schema.authChallenges.purpose, "stepup"),
    eq(schema.authChallenges.provider, "totp"),
    eq(schema.authChallenges.challengeHash, sha256(ticket)),
    eq(schema.authChallenges.staffUserId, user.id),
    eq(schema.authChallenges.sessionHash, sha256(sessionToken)),
    isNull(schema.authChallenges.usedAt),
    gt(schema.authChallenges.expiresAt, new Date()),
  )).limit(1))[0];
  if (!row?.verifier || !/^\d{6}$/.test(code.trim())) return false;
  let base32: string;
  try {
    base32 = await decryptSecret(row.verifier);
  } catch {
    return false;
  }
  const step = await matchedStep(totpFor(user.staffId, base32), code.trim());
  if (step === null) return false;
  const hashes = JSON.parse(row.issuer || "[]") as unknown;
  if (!Array.isArray(hashes) || hashes.some((item) => typeof item !== "string")) return false;
  await db.insert(schema.staffTotp).values({
    staffUserId: user.id,
    tenantId: user.tenantId,
    secretEnc: row.verifier,
    enrolledAt: new Date(),
    lastStep: step,
  }).onConflictDoNothing();
  const enrolled = await totpEnrolled(db, user.id);
  if (!enrolled) return false;
  await db.delete(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, user.id));
  if (hashes.length) {
    await db.insert(schema.staffRecoveryCodes).values(hashes.map((codeHash) => ({
      id: `rcv-${randomUUID()}`,
      staffUserId: user.id,
      codeHash: codeHash as string,
    })));
  }
  await db.update(schema.authChallenges).set({ usedAt: new Date() }).where(eq(schema.authChallenges.id, row.id));
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

/** TOTP or one backup code. A used backup code does not work again.
    The same TOTP step does not work twice. */
export async function verifyOwnerFactor(db: Db, user: Staff, code: string): Promise<"totp" | "backup" | null> {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    const row = (await db.select().from(schema.staffTotp).where(eq(schema.staffTotp.staffUserId, user.id)).limit(1))[0];
    if (!row?.enrolledAt) return null;
    let base32: string;
    try {
      base32 = await decryptSecret(row.secretEnc);
    } catch {
      return null;
    }
    const step = await matchedStep(totpFor(user.staffId, base32), trimmed);
    if (step === null || (row.lastStep != null && step <= row.lastStep)) return null;
    await db.update(schema.staffTotp).set({ lastStep: step }).where(eq(schema.staffTotp.staffUserId, user.id));
    return "totp";
  }
  const normalized = normalizeBackupCode(trimmed);
  if (normalized.length < 8) return null;
  const codes = await db.select().from(schema.staffRecoveryCodes).where(and(
    eq(schema.staffRecoveryCodes.staffUserId, user.id),
    isNull(schema.staffRecoveryCodes.usedAt),
  ));
  for (const row of codes) {
    if (await verifyPassword(normalized, row.codeHash)) {
      const spent = await db.update(schema.staffRecoveryCodes).set({ usedAt: new Date() }).where(and(
        eq(schema.staffRecoveryCodes.id, row.id),
        isNull(schema.staffRecoveryCodes.usedAt),
      )).returning();
      if (!spent.length) return null;
      await audit(db, {
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        actorId: user.id,
        action: SIGN_IN_AUDIT.recoveryUsed,
        detail: signInAuditDetail({ method: "backup", result: "ok", staffId: user.staffId, shop: user.tenantId }),
      });
      return "backup";
    }
  }
  return null;
}

export async function regenerateRecoveryCodes(db: Db, user: Staff): Promise<string[] | null> {
  if (user.role !== "administrator" || !(await totpEnrolled(db, user.id))) return null;
  const backupCodes = Array.from({ length: BACKUP_COUNT }, () => generateBackupCode());
  const hashes = await Promise.all(backupCodes.map((code) => hashPassword(normalizeBackupCode(code))));
  await db.delete(schema.staffRecoveryCodes).where(eq(schema.staffRecoveryCodes.staffUserId, user.id));
  await db.insert(schema.staffRecoveryCodes).values(hashes.map((codeHash) => ({
    id: `rcv-${randomUUID()}`,
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
