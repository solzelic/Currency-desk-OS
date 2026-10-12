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
import { eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { verifyPassword } from "./password.js";
import { looksLikeCdId, normalizeCdId } from "./cdid.js";

/** Five wrong passwords on one account inside this window, then a lock. */
export const SIGNIN_ACCOUNT_MAX = 5;
/** One address spraying many ids. A shop shares an address, so this is looser. */
export const SIGNIN_IP_MAX = 20;
export const SIGNIN_WINDOW_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;

/* Same scrypt cost as a real password (N=16384, r=8, p=1 in password.ts).
   An unknown id is checked against this so the answer is not faster. */
const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

/** Compared once on every code step. The result is never a sign-in. */
export const DUMMY_CODE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const LOGIN_PROOF_COOKIE = "cdos_login_proof";

/** Same words for an unknown id and a wrong code. The screen prints `detail`. */
export const CODE_REFUSAL = {
  error: "wrong_code" as const,
  detail: "That code isn't right — check your email.",
};

export type SignInDecision =
  | { result: "pass" }
  | { result: "fail" }
  | { result: "locked"; minutes: number; retryAfter: number; scope: "account" | "ip" };

export function lockBody(locked: { minutes: number; retryAfter: number }): {
  error: "too_many_attempts";
  detail: string;
  retryAfter: number;
} {
  const unit = locked.minutes === 1 ? "minute" : "minutes";
  return {
    error: "too_many_attempts",
    detail: `Too many tries. Try again in ${locked.minutes} ${unit}.`,
    retryAfter: locked.retryAfter,
  };
}

export function accountKeyFor(userId: string | undefined, tenantId: string, staffId: string): string {
  if (userId) return `acct:${userId}`;
  return `miss:${tenantId}:${staffId.trim().toLowerCase()}`;
}

export function ipBucket(ip: string): string {
  return `ip:${ip}`;
}

/* Render's proxy appends the address it saw. The rightmost hop is that
   address; the leftmost is whatever the caller typed, so it is not the
   one we count. With no header (tests, a process that is not behind the
   proxy) the socket address is the client. A direct caller can still
   put a header on the request — the deployed process is reached through
   Render, which is the hop that appends. */
export function clientIp(req: { ip?: string; headers: { [name: string]: unknown } }): string {
  const header = req.headers["x-forwarded-for"];
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw === "string" && raw.trim()) {
    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    const addedByProxy = parts[parts.length - 1];
    if (addedByProxy) return addedByProxy;
  }
  const ip = req.ip?.trim();
  if (!ip) throw new Error("Sign-in has no client address to count.");
  return ip;
}

type Bucket = { failures: number; windowStartedAt: Date };

function timeLeft(windowStartedAt: Date, now: number): { minutes: number; retryAfter: number } | null {
  const elapsed = now - windowStartedAt.getTime();
  if (elapsed >= SIGNIN_WINDOW_MS) return null;
  const remainMs = SIGNIN_WINDOW_MS - elapsed;
  return {
    retryAfter: Math.max(1, Math.ceil(remainMs / 1000)),
    minutes: Math.max(1, Math.ceil(remainMs / 60_000)),
  };
}

function lockFrom(row: Bucket | undefined, max: number, scope: "account" | "ip", now: number): SignInDecision | null {
  if (!row || row.failures < max) return null;
  const left = timeLeft(row.windowStartedAt, now);
  if (!left) return null;
  return { result: "locked", scope, ...left };
}

function stricter(a: SignInDecision | null, b: SignInDecision | null): SignInDecision | null {
  if (!a || a.result !== "locked") return b;
  if (!b || b.result !== "locked") return a;
  return a.retryAfter >= b.retryAfter ? a : b;
}

async function readBucket(db: Db, bucket: string): Promise<Bucket | undefined> {
  const rows = await db
    .select({ failures: schema.signinFailures.failures, windowStartedAt: schema.signinFailures.windowStartedAt })
    .from(schema.signinFailures)
    .where(eq(schema.signinFailures.bucket, bucket))
    .limit(1);
  return rows[0];
}

/* The 15-minute literal matches SIGNIN_WINDOW_MS. A window that has
   already elapsed starts again at 1; it does not keep growing.
   Raw SQL because the two Drizzle drivers do not share one `.returning`
   signature, and the count has to be the row the database just wrote. */
async function bump(db: Db, bucket: string): Promise<Bucket> {
  const result = await db.execute(sql`
    INSERT INTO signin_failures (bucket, failures, window_started_at)
    VALUES (${bucket}, 1, now())
    ON CONFLICT (bucket) DO UPDATE SET
      failures = CASE
        WHEN signin_failures.window_started_at <= now() - interval '15 minutes' THEN 1
        ELSE signin_failures.failures + 1
      END,
      window_started_at = CASE
        WHEN signin_failures.window_started_at <= now() - interval '15 minutes' THEN now()
        ELSE signin_failures.window_started_at
      END
    RETURNING failures, window_started_at
  `);
  const row = result.rows[0] as { failures?: number | string; window_started_at?: string | Date } | undefined;
  if (!row || row.failures === undefined || row.window_started_at === undefined) {
    throw new Error("Sign-in failure count was not stored.");
  }
  const windowStartedAt = row.window_started_at instanceof Date ? row.window_started_at : new Date(row.window_started_at);
  if (Number.isNaN(windowStartedAt.getTime())) throw new Error("Sign-in failure window was not stored.");
  return { failures: Number(row.failures), windowStartedAt };
}

/**
 * Always checks the password, including when the account is already
 * locked or missing, so those answers are not the fast ones. A correct
 * password during a lock still fails. A pass clears only the account
 * bucket — the address keeps what it has earned.
 */
export async function judgeSignIn(
  db: Db,
  input: { password: string; storedHash: string | null; accountKey: string; ip: string; eligible: boolean },
): Promise<SignInDecision> {
  const passwordOk = await verifyPassword(input.password, input.storedHash ?? DUMMY_PASSWORD_HASH);
  const now = Date.now();
  const ipKey = ipBucket(input.ip);
  const [accountRow, ipRow] = await Promise.all([readBucket(db, input.accountKey), readBucket(db, ipKey)]);
  const already = stricter(
    lockFrom(accountRow, SIGNIN_ACCOUNT_MAX, "account", now),
    lockFrom(ipRow, SIGNIN_IP_MAX, "ip", now),
  );
  if (already) return already;
  if (!input.eligible || !passwordOk) {
    const [accountNext, ipNext] = await Promise.all([bump(db, input.accountKey), bump(db, ipKey)]);
    const tripped = stricter(
      lockFrom(accountNext, SIGNIN_ACCOUNT_MAX, "account", Date.now()),
      lockFrom(ipNext, SIGNIN_IP_MAX, "ip", Date.now()),
    );
    return tripped ?? { result: "fail" };
  }
  await db.delete(schema.signinFailures).where(eq(schema.signinFailures.bucket, input.accountKey));
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
  await db.delete(schema.loginChallenges).where(eq(schema.loginChallenges.userId, userId));
  await db.insert(schema.loginChallenges).values({ tokenHash, userId, codeHash, expiresAt, attempts: 0 });
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

/** No cookie and an unknown cookie are the same state. Neither reads a staff id. */
export async function loadLoginProof(db: Db, token: string | undefined): Promise<LoginProof> {
  if (!token) return { state: "absent" };
  const tokenHash = sha256(token);
  const rows = await db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.tokenHash, tokenHash)).limit(1);
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

export async function noteWrongCode(db: Db, tokenHash: string, attempts: number): Promise<void> {
  await db.update(schema.loginChallenges).set({ attempts: attempts + 1 }).where(eq(schema.loginChallenges.tokenHash, tokenHash));
}

export function staffMatches(user: { staffId: string; cdId: string | null }, submitted: string): boolean {
  const typed = submitted.trim();
  if (typed.toLowerCase() === user.staffId.trim().toLowerCase()) return true;
  return !!user.cdId && looksLikeCdId(typed) && normalizeCdId(typed) === user.cdId;
}
