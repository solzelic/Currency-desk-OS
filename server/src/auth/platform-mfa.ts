/* Platform-operator second factor.

   The panel is the keys to every desk, so a password is not enough once
   the operator has an authenticator. The first sign-in after deploy has
   nothing to type yet — locking that door would lock the owner out — so
   a correct password starts enrollment: the secret is returned once, as
   an otpauth URI, with one-time backup codes. Nothing is stored as
   enrolled until a code from that secret verifies. The next sign-in
   requires a code or a backup code, and a backup code works once.

   The secret is encrypted (see totp-secret.ts). Backup codes are scrypt
   hashes, the same function as a password. Neither is logged.

   Desk sign-in does not come through here. A teller session is still a
   password session; the admin routes are what refuse it after enrollment.
   */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { TOTP, Secret } from "otpauth";
import { schema, type Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "./password.js";
import { decryptSecret, encryptSecret } from "./totp-secret.js";

const ISSUER = "CurrencyDesk";
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const BACKUP_COUNT = 10;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export type MfaFailure = "no_challenge" | "expired" | "too_many_attempts" | "wrong_code" | "already_enrolled";

export type MfaResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MfaFailure; email?: string };

function failed(error: MfaFailure, email?: string): MfaResult<never> {
  return { ok: false, error, ...(email ? { email } : {}) };
}

export function normalizeBackupCode(input: string): string {
  return input.trim().toLowerCase().replace(/[\s-]/g, "");
}

function generateBackupCode(): string {
  const bytes = randomBytes(10);
  const body = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${body.slice(0, 5)}-${body.slice(5)}`;
}

function totpFor(email: string, base32: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: "SHA1",
    digits: DIGITS,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(base32),
  });
}

/* SHA1 is what authenticator apps actually implement. A stronger hash
   here is a secret the phone will not accept. */
function freshTotp(email: string): { totp: TOTP; base32: string } {
  const secret = new Secret({ size: 20 });
  const base32 = secret.base32;
  return {
    base32,
    totp: new TOTP({
      issuer: ISSUER,
      label: email,
      algorithm: "SHA1",
      digits: DIGITS,
      period: PERIOD_SECONDS,
      secret,
    }),
  };
}

export async function platformMfaEnrolled(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ at: schema.platformUsers.totpEnrolledAt })
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.email, email.toLowerCase()))
    .limit(1);
  return !!rows[0]?.at;
}

type Challenge = typeof schema.platformMfaChallenges.$inferSelect;

async function loadChallenge(db: Db, ticket: string, purpose: "enroll" | "login"): Promise<MfaResult<Challenge>> {
  const rows = await db
    .select()
    .from(schema.platformMfaChallenges)
    .where(eq(schema.platformMfaChallenges.id, sha256(ticket)))
    .limit(1);
  const row = rows[0];
  if (!row || row.purpose !== purpose) return failed("no_challenge");
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
    return failed("expired", row.email);
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
    return failed("too_many_attempts", row.email);
  }
  return { ok: true, value: row };
}

async function rejectCode(db: Db, row: Challenge): Promise<MfaFailure> {
  const next = row.attempts + 1;
  if (next >= MAX_ATTEMPTS) {
    await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
    return "too_many_attempts";
  }
  await db.update(schema.platformMfaChallenges).set({ attempts: next }).where(eq(schema.platformMfaChallenges.id, row.id));
  return "wrong_code";
}

/* The matched step has to move forward. The same six digits are valid for
   the whole window; accepting them twice would make a shoulder-surfed
   code a second sign-in. */
async function matchedStep(totp: TOTP, token: string): Promise<number | null> {
  const timestamp = Date.now();
  const delta = totp.validate({ token, timestamp, window: WINDOW });
  if (delta === null) return null;
  return TOTP.counter({ period: PERIOD_SECONDS, timestamp }) + delta;
}

export async function beginPlatformMfa(db: Db, email: string): Promise<
  | { step: "enroll"; ticket: string; otpauthUri: string; manualSecret: string; backupCodes: string[] }
  | { step: "totp"; ticket: string }
> {
  const key = email.toLowerCase();
  const enrolled = await platformMfaEnrolled(db, key);
  await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.email, key));
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  if (!enrolled) {
    const created = freshTotp(key);
    const backupCodes = Array.from({ length: BACKUP_COUNT }, () => generateBackupCode());
    const backupHashes = await Promise.all(backupCodes.map((code) => hashPassword(normalizeBackupCode(code))));
    await db.insert(schema.platformMfaChallenges).values({
      id: sha256(ticket),
      email: key,
      purpose: "enroll",
      secretEnc: await encryptSecret(created.base32),
      backupHashes,
      expiresAt,
    });
    return {
      step: "enroll",
      ticket,
      otpauthUri: created.totp.toString(),
      manualSecret: created.base32,
      backupCodes,
    };
  }
  await db.insert(schema.platformMfaChallenges).values({
    id: sha256(ticket),
    email: key,
    purpose: "login",
    expiresAt,
  });
  return { step: "totp", ticket };
}

async function hashesOf(value: unknown): Promise<string[]> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function confirmPlatformEnrollment(db: Db, ticket: string, code: string): Promise<MfaResult<{ email: string }>> {
  const loaded = await loadChallenge(db, ticket, "enroll");
  if (!loaded.ok) return loaded;
  const row = loaded.value;
  const token = code.trim();
  if (!/^\d{6}$/.test(token) || !row.secretEnc) {
    return failed(await rejectCode(db, row), row.email);
  }
  let base32: string;
  try {
    base32 = await decryptSecret(row.secretEnc);
  } catch {
    console.error("[platform-mfa] stored authenticator secret could not be decrypted");
    return failed(await rejectCode(db, row), row.email);
  }
  const step = await matchedStep(totpFor(row.email, base32), token);
  if (step === null) return failed(await rejectCode(db, row), row.email);

  /* First confirmer wins. A second ticket must not replace the secret
     the owner just saved — that is how a stolen password locks them out
     of their own authenticator after they have enrolled. */
  const wrote = await db
    .update(schema.platformUsers)
    .set({ totpSecretEnc: row.secretEnc, totpEnrolledAt: new Date(), totpLastStep: step })
    .where(and(eq(schema.platformUsers.email, row.email), isNull(schema.platformUsers.totpEnrolledAt)))
    .returning();
  if (!wrote.length) {
    await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
    return failed("already_enrolled", row.email);
  }
  const hashes = await hashesOf(row.backupHashes);
  await db.delete(schema.platformMfaBackupCodes).where(eq(schema.platformMfaBackupCodes.email, row.email));
  if (hashes.length) {
    await db.insert(schema.platformMfaBackupCodes).values(hashes.map((codeHash) => ({
      id: randomUUID(),
      email: row.email,
      codeHash,
    })));
  }
  await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
  return { ok: true, value: { email: row.email } };
}

async function acceptTotp(db: Db, email: string, secretEnc: string, token: string): Promise<boolean> {
  let base32: string;
  try {
    base32 = await decryptSecret(secretEnc);
  } catch {
    console.error("[platform-mfa] stored authenticator secret could not be decrypted");
    return false;
  }
  const step = await matchedStep(totpFor(email, base32), token);
  if (step === null) return false;
  const wrote = await db
    .update(schema.platformUsers)
    .set({ totpLastStep: step })
    .where(and(
      eq(schema.platformUsers.email, email),
      or(isNull(schema.platformUsers.totpLastStep), lt(schema.platformUsers.totpLastStep, step)),
    ))
    .returning();
  return wrote.length > 0;
}

async function acceptBackup(db: Db, email: string, code: string): Promise<boolean> {
  const normalized = normalizeBackupCode(code);
  if (normalized.length < 8) return false;
  const rows = await db
    .select()
    .from(schema.platformMfaBackupCodes)
    .where(and(eq(schema.platformMfaBackupCodes.email, email), isNull(schema.platformMfaBackupCodes.usedAt)));
  const checks = await Promise.all(rows.map(async (row) => ({
    id: row.id,
    ok: await verifyPassword(normalized, row.codeHash),
  })));
  const match = checks.find((item) => item.ok);
  if (!match) return false;
  const burned = await db
    .update(schema.platformMfaBackupCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.platformMfaBackupCodes.id, match.id), isNull(schema.platformMfaBackupCodes.usedAt)))
    .returning();
  return burned.length > 0;
}

export async function confirmPlatformLogin(
  db: Db,
  ticket: string,
  code: string,
): Promise<MfaResult<{ email: string; factor: "totp" | "backup" }>> {
  const loaded = await loadChallenge(db, ticket, "login");
  if (!loaded.ok) return loaded;
  const row = loaded.value;
  const enrolled = await db
    .select({ secret: schema.platformUsers.totpSecretEnc })
    .from(schema.platformUsers)
    .where(eq(schema.platformUsers.email, row.email))
    .limit(1);
  const secret = enrolled[0]?.secret;
  if (!secret) return failed(await rejectCode(db, row), row.email);

  const token = code.trim();
  const factor = /^\d{6}$/.test(token) ? "totp" : "backup";
  const accepted = factor === "totp"
    ? await acceptTotp(db, row.email, secret, token)
    : await acceptBackup(db, row.email, token);
  if (!accepted) return failed(await rejectCode(db, row), row.email);
  await db.delete(schema.platformMfaChallenges).where(eq(schema.platformMfaChallenges.id, row.id));
  return { ok: true, value: { email: row.email, factor } };
}
