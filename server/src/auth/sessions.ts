/* ============================================================
   Sessions — opaque random tokens in an httpOnly cookie.
   The DB stores only SHA-256(token): a database leak cannot be
   replayed as a login. Sliding 12h expiry, hard revocation on
   logout. No JWTs — sessions for a teller desk should be
   individually revocable the moment someone is let go.
   ============================================================ */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";

export const SESSION_COOKIE = "cdos_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // one desk shift

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  staffId: string;
  name: string;
  role: "teller" | "supervisor" | "compliance_officer" | "branch_manager" | "administrator" | "auditor";
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  authorizedBranchIds: string[];
  mustChangePassword: boolean;
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = await db
    .select({ user: schema.staffUsers })
    .from(schema.sessions)
    .innerJoin(schema.staffUsers, eq(schema.sessions.userId, schema.staffUsers.id))
    .where(
      and(
        eq(schema.sessions.tokenHash, sha256(token)),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, new Date()),
        eq(schema.staffUsers.active, true),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const u = row.user;
  return {
    id: u.id,
    staffId: u.staffId,
    name: u.name,
    role: u.role,
    tenantId: u.tenantId,
    legalEntityId: u.legalEntityId,
    branchId: u.branchId,
    authorizedBranchIds: u.authorizedBranchIds,
    mustChangePassword: u.mustChangePassword,
  };
}

export async function revokeSession(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, sha256(token)));
}

/* Kill every live session a person holds — the moment a password is reset or
   an account is deactivated, existing logins stop working everywhere.
   `keepToken` preserves the caller's own session (self-service password change). */
export async function revokeAllSessions(db: Db, userId: string, keepToken?: string): Promise<void> {
  const conds = [eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)];
  if (keepToken) conds.push(ne(schema.sessions.tokenHash, sha256(keepToken)));
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(and(...conds));
}
