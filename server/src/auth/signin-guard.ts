/* Shop sign-in limits, and the marker that the password step passed.

   Two holes sat on the desk door. Password guesses were unlimited, and
   the emailed-code step answered differently when the staff id was
   unknown than when the code was wrong — so the code step was a way to
   ask "does this person exist?" without knowing a password.

   The counts live in Postgres. An in-memory map forgets them on every
   Render sleep and every deploy, which is a fresh set of guesses. The
   code step will not compare a code unless this browser already proved
   the password: the proof is a random cookie, and the row stores only
   its hash. */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { verifyPassword } from "./password.js";
import { looksLikeCdId, normalizeCdId } from "./cdid.js";
import { CD_ID_RE } from "../enquiries/cd-id.js";
import { z } from "zod";

/** The pack's shared limits apply to every desk password door. */
export const SIGNIN_ACCOUNT_MAX = 10;
export const SIGNIN_IP_MAX = 10;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;

/* Public dummy hashes match the current scrypt and Argon2id costs. Every
   attempt pays both costs; eligibility, never a dummy match, grants access. */
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const DUMMY_ARGON_HASH = "$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$DamYDHeNnBqV5YiouC+sNFczNKeIGxB+aellQbSAFE4";

/** Compared once on every code step. The result is never a sign-in. */
export const DUMMY_CODE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const LOGIN_PROOF_COOKIE = "cdos_login_proof";

/** Unproven or mismatched identity gets no challenge or attempt information. */
export const CODE_REFUSAL = {
  error: "wrong_code" as const,
  detail: "That code isn't right. Check your email.",
};

export type SignInDecision =
  | { result: "pass" }
  | { result: "fail" }
  | { result: "locked"; minutes: number; retryAfter: number; retryAt: Date; scope: "account" | "ip" };

/** 12-hour clock in the branch's zone: "10:42 AM". The phone lock screen
    prints this. An unusable zone is a thrown error, not a UTC fallback
    that would tell the desk the wrong time. */
export function formatLockClock(at: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(at);
  } catch (err) {
    throw new Error(`Sign-in lock could not be shown in ${timeZone}.`, { cause: err });
  }
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const dayPeriod = parts.find((part) => part.type === "dayPeriod")?.value?.replace(/\s/g, "").toUpperCase();
  if (!hour || !minute || (dayPeriod !== "AM" && dayPeriod !== "PM")) {
    throw new Error(`Sign-in lock could not be shown in ${timeZone}.`);
  }
  return `${hour}:${minute} ${dayPeriod}`;
}

export function lockBody(locked: { minutes: number; retryAfter: number; retryAt: Date }, timeZone: string): {
  error: "too_many_attempts";
  detail: string;
  retryAfter: number;
  retryAt: string;
  timeZone: string;
  until: string;
} {
  const unit = locked.minutes === 1 ? "minute" : "minutes";
  return {
    error: "too_many_attempts",
    detail: `Too many tries. Try again in ${locked.minutes} ${unit}.`,
    retryAfter: locked.retryAfter,
    retryAt: locked.retryAt.toISOString(),
    timeZone,
    until: formatLockClock(locked.retryAt, timeZone),
  };
}

export function accountKeyFor(userId: string | undefined, tenantId: string, staffId: string): string {
  if (userId) return `acct:${userId}`;
  return `miss:${tenantId}:${staffId.trim().toLowerCase()}`;
}

export function ipBucket(ip: string): string {
  return `ip:${ip}`;
}

/** Separate staging ticket quota: the 20th call counts; the 21st is over. */
export async function stagingAddressLimited(db: Db, ip: string): Promise<boolean> {
  const row = await bump(db, `staging:${ip}`);
  return lockFrom(row, 20, "ip", true) != null;
}

type Bucket = { failures: number; windowStartedAt: Date; windowToken: string };

function timeLeft(windowStartedAt: Date, now: number): { minutes: number; retryAfter: number } | null {
  const elapsed = now - windowStartedAt.getTime();
  if (elapsed >= SIGNIN_WINDOW_MS) return null;
  const remainMs = SIGNIN_WINDOW_MS - elapsed;
  return {
    retryAfter: Math.max(1, Math.ceil(remainMs / 1000)),
    minutes: Math.max(1, Math.ceil(remainMs / 60_000)),
  };
}

/* A correct password at the limit can pass: its reservation is not a miss.
   An attempt past the limit is refused even when the password is right. */
function lockFrom(row: Pick<Bucket, "failures" | "windowStartedAt">, max: number, scope: "account" | "ip", pastOnly: boolean): SignInDecision | null {
  const tripped = pastOnly ? row.failures > max : row.failures >= max;
  if (!tripped) return null;
  const left = timeLeft(row.windowStartedAt, Date.now());
  if (!left) throw new Error("Sign-in lock window was not stored.");
  return {
    result: "locked",
    scope,
    ...left,
    retryAt: new Date(row.windowStartedAt.getTime() + SIGNIN_WINDOW_MS),
  };
}

function stricter(a: SignInDecision | null, b: SignInDecision | null): SignInDecision | null {
  if (!a || a.result !== "locked") return b;
  if (!b || b.result !== "locked") return a;
  return a.retryAfter >= b.retryAfter ? a : b;
}

/* The 15-minute literal matches SIGNIN_WINDOW_MS. A window that has
   already elapsed starts again at 1; it does not keep growing.
   Raw SQL because the two Drizzle drivers do not share one `.returning`
   signature, and the count has to be the row the database just wrote. */
async function bump(db: Db, bucket: string, ceiling?: number): Promise<Bucket> {
  const increment = ceiling === undefined ? sql`signin_failures.failures + 1` : sql`LEAST(signin_failures.failures + 1, ${ceiling})`;
  const result = await db.execute(sql`
    INSERT INTO signin_failures (bucket, failures, window_started_at)
    VALUES (${bucket}, 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      failures = CASE
        WHEN signin_failures.window_started_at <= now() - interval '15 minutes' THEN 1
        ELSE ${increment}
      END,
      window_started_at = CASE
        WHEN signin_failures.window_started_at <= now() - interval '15 minutes' THEN now()
        ELSE signin_failures.window_started_at
      END
    RETURNING failures, window_started_at::text AS window_started_at
  `);
  const parsed = z.object({ failures: z.coerce.number().int().positive(), window_started_at: z.union([z.string(), z.date()]) }).safeParse(result.rows[0]);
  if (!parsed.success) throw new Error("Sign-in failure count was not stored.");
  const row = parsed.data;
  const windowStartedAt = row.window_started_at instanceof Date ? row.window_started_at : new Date(row.window_started_at);
  if (Number.isNaN(windowStartedAt.getTime())) throw new Error("Sign-in failure window was not stored.");
  // Keep Postgres's microseconds for the compare-and-release, not Date's
  // millisecond projection. Otherwise a successful attempt never clears.
  const windowToken = typeof row.window_started_at === "string" ? row.window_started_at : row.window_started_at.toISOString();
  return { failures: Number(row.failures), windowStartedAt, windowToken };
}

/* A success is not a failed guess. The increment above already counted
   it, so the decision could see a number. Take that one back, and clear
   the account only when this attempt is still the latest row. A burst
   that has already run past the limit keeps its count: wiping it would
   hand the next correct password a fresh set of guesses. */
async function releaseSuccess(db: Db, accountKey: string, account: Bucket, ipKey: string, ip: Bucket): Promise<void> {
  await db.execute(sql`DELETE FROM signin_failures WHERE bucket = ${accountKey} AND failures = ${account.failures}
    AND window_started_at = ${account.windowToken}::timestamptz`);
  // A late success must not lower a connection that another request locked,
  // or touch a new window after its own password check was delayed.
  await db.execute(sql`UPDATE signin_failures SET failures = failures - 1 WHERE bucket = ${ipKey} AND failures > 0
    AND window_started_at = ${ip.windowToken}::timestamptz
    AND (failures < ${SIGNIN_IP_MAX} OR failures = ${ip.failures})`);
  await db.execute(sql`DELETE FROM signin_failures WHERE bucket = ${ipKey} AND failures = 0
    AND window_started_at = ${ip.windowToken}::timestamptz`);
}

const identifierKey = (identifier: string) => `start:id:${createHash("sha256").update(normalizeCdId(identifier)).digest("hex")}`;

/** Read locks before looking up a shop; blocked requests never grow buckets. */
export async function identifierStartLock(db: Db, identifier: string, ip: string): Promise<SignInDecision | null> {
  for (const [bucket, max, scope] of [[`start:ip:${ip}`, SIGNIN_IP_MAX, "ip"], [identifierKey(identifier), SIGNIN_ACCOUNT_MAX, "account"]] as const) {
    const rows = await db.select().from(schema.signinFailures).where(sql`bucket = ${bucket}
      AND window_started_at > now() - interval '15 minutes'`).limit(1);
    const locked = rows[0] ? lockFrom(rows[0], max, scope, false) : null;
    if (locked) return locked;
  }
  return null;
}

/** Only unknown/suppressed ID lookups are misses (the pack permits shop names).
 * Reserve the connection first. In-flight bursts may reach max+1, but cannot
 * grow its counter further or create more ID rows after that boundary. */
export async function noteIdentifierStartMiss(db: Db, identifier: string, ip: string): Promise<SignInDecision | null> {
  const connection = await bump(db, `start:ip:${ip}`, SIGNIN_IP_MAX + 1);
  const over = lockFrom(connection, SIGNIN_IP_MAX, "ip", true);
  if (over) return over;
  const account = await bump(db, identifierKey(identifier), SIGNIN_ACCOUNT_MAX + 1);
  return stricter(lockFrom(account, SIGNIN_ACCOUNT_MAX, "account", false), lockFrom(connection, SIGNIN_IP_MAX, "ip", false));
}

/** An owner, a manager, or a break-glass reset. The address counter stays.
    No row is a finished clear, not a failure: they were not locked. */
export async function clearSignInLock(db: Db, userId: string): Promise<void> {
  await db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, `acct:${userId}`));
}

/**
 * The count is written before the decision, in one statement, and the
 * number that statement returns is the one we judge. A read-then-write
 * lets a burst all see "nine" and a correct password walk through after
 * the tenth failure has already landed.
 *
 * Until a reservation exceeds the limit, a missing account pays the same
 * hashing cost. Already-over-limit requests skip hashing for every identity;
 * those answers depend on the shared counters, not account existence.
 * A correct password past the limit still fails. A pass under the
 * limit clears the account count and puts back the address increment.
 */
export async function judgeSignIn(
  db: Db,
  input: { password: string; storedHash: string | null; accountKey: string; ip: string; eligible: boolean },
): Promise<SignInDecision> {
  const ipKey = ipBucket(input.ip);
  /* Account, then address. The same order on every request, so two
     guesses cannot each hold the other's row. */
  const accountNext = await bump(db, input.accountKey);
  const ipNext = await bump(db, ipKey);
  // Once a reservation is past either limit, no password can pass. This
  // fast refusal is identical for known and unknown accounts and avoids
  // unbounded Argon2 work from an already locked connection.
  const alreadyLocked = stricter(lockFrom(accountNext, SIGNIN_ACCOUNT_MAX, "account", true), lockFrom(ipNext, SIGNIN_IP_MAX, "ip", true));
  if (alreadyLocked) return alreadyLocked;
  const stored = input.storedHash ?? DUMMY_ARGON_HASH;
  const passwordOk = await verifyPassword(input.password, stored);
  // One Argon2id and one legacy scrypt verification on every path, including
  // unknown accounts and lockouts. Never infer eligibility from a dummy match.
  await verifyPassword(input.password, stored.startsWith("$argon2id$") ? DUMMY_PASSWORD_HASH : DUMMY_ARGON_HASH);
  const under = passwordOk && input.eligible;
  const locked = stricter(
    lockFrom(accountNext, SIGNIN_ACCOUNT_MAX, "account", under),
    lockFrom(ipNext, SIGNIN_IP_MAX, "ip", under),
  );
  if (locked) return locked;
  if (!under) return { result: "fail" };
  await releaseSuccess(db, input.accountKey, accountNext, ipKey, ipNext);
  return { result: "pass" };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createLoginProof(
  db: Db,
  userId: string,
  codeHash: string,
): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  // Call with the root database: the helper must commit before mail is sent.
  await db.transaction(async tx => {
    // Nested Drizzle transactions ignore isolation options. Refuse a stale
    // inherited snapshot before taking locks or replacing an existing proof.
    const isolation = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS level`);
    if (isolation.rows[0]?.level !== "read committed") throw new Error("Login proof issuance requires READ COMMITTED");
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    // Serialize even when no proof exists. All issuers must use this helper.
    // Do not lock staff first: verification holds proof -> staff -> tenant.
    // The verifier never needs this issuer lock, so it can finish while we wait.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`login-proof:${userId}`}, 0))`);
    await tx.delete(schema.loginChallenges).where(eq(schema.loginChallenges.userId, userId));
    await tx.insert(schema.loginChallenges).values({ tokenHash, userId, codeHash, expiresAt, attempts: 0 });
  }, { isolationLevel: "read committed" }); // DELETE must see the preceding issuer's commit after waiting.
  // Commit orders proof validity, not email arrival. The caller sends mail only
  // after this transaction releases its locks; a confirmed rollback keeps old proof.
  return { token, tokenHash, expiresAt };
}

export async function deleteLoginProof(db: Db, tokenHash: string): Promise<void> {
  await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.tokenHash, tokenHash));
}

export type LoginProof =
  | { state: "absent" }
  | { state: "expired" }
  | { state: "exhausted" }
  | { state: "ready"; tokenHash: string; userId: string; codeHash: string; attempts: number };

/** Transaction-only: hold this proof through validation, attempt accounting and
 * session/audit commit. No cookie/unknown cookie ever reads a staff identity. */
export async function loadLoginProof(db: Db, token: string | undefined): Promise<LoginProof> {
  if (!token) return { state: "absent" };
  const tokenHash = sha256(token);
  const rows = await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.tokenHash, tokenHash)).limit(1).for("update");
  const row = rows[0];
  if (!row) return { state: "absent" };
  if (row.expiresAt.getTime() <= Date.now()) {
    await deleteLoginProof(db, tokenHash);
    return { state: "expired" };
  }
  if (row.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    await deleteLoginProof(db, tokenHash);
    return { state: "exhausted" };
  }
  return { state: "ready", tokenHash, userId: row.userId, codeHash: row.codeHash, attempts: row.attempts };
}

// clock_timestamp(), not transaction-start now(): a request may have waited
// on identity/tenant locks since loading its proof. Check at the actual write.
const usableProof = (tokenHash: string) => and(
  eq(schema.loginChallenges.tokenHash, tokenHash),
  lt(schema.loginChallenges.attempts, CHALLENGE_MAX_ATTEMPTS),
  sql`${schema.loginChallenges.expiresAt} > clock_timestamp()`,
);

/** Transaction-only: remaining guesses at this write, or null if no usable row.
 * The caller must commit before exposing the count, including terminal zero. */
export async function noteWrongCode(db: Db, tokenHash: string): Promise<number | null> {
  const rows = await db.update(schema.loginChallenges)
    .set({ attempts: sql`${schema.loginChallenges.attempts} + 1` })
    .where(usableProof(tokenHash)).returning();
  const row = rows[0];
  return row ? CHALLENGE_MAX_ATTEMPTS - z.number().int().min(1).max(CHALLENGE_MAX_ATTEMPTS).parse(row.attempts) : null;
}

/** Only the returned deletion authorizes a session, inside the same transaction. */
export async function consumeLoginProof(db: Db, tokenHash: string): Promise<boolean> {
  const rows = await db.delete(schema.loginChallenges).where(usableProof(tokenHash))
    .returning();
  return rows.length === 1;
}

export function staffMatches(user: { staffId: string; cdId: string | null }, submitted: string): boolean {
  const typed = submitted.trim();
  if (typed.toLowerCase() === user.staffId.trim().toLowerCase()) return true;
  return !!user.cdId && (looksLikeCdId(typed) || CD_ID_RE.test(normalizeCdId(typed))) && normalizeCdId(typed) === user.cdId;
}
