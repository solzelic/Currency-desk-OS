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
  const workspaceId = await homeWorkspaceId(db, userId);
  await db.insert(schema.sessions).values({
    tokenHash: sha256(token),
    userId,
    expiresAt,
    ...(workspaceId ? { workspaceId } : {}),
  });
  return { token, expiresAt };
}

export async function setSessionWorkspace(db: Db, token: string, workspaceId: string): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ workspaceId })
    .where(eq(schema.sessions.tokenHash, sha256(token)));
}

async function homeWorkspaceId(db: Db, userId: string): Promise<string | undefined> {
  const rows = await db
    .select({
      tenantId: schema.staffUsers.tenantId,
      legalEntityId: schema.staffUsers.legalEntityId,
      branchId: schema.staffUsers.branchId,
    })
    .from(schema.staffUsers)
    .where(eq(schema.staffUsers.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) return undefined;
  const tills = await db
    .select({ id: schema.workspaces.id, tillId: schema.workspaces.tillId })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.tenantId, user.tenantId),
        eq(schema.workspaces.legalEntityId, user.legalEntityId),
        eq(schema.workspaces.branchId, user.branchId),
      ),
    );
  return [...tills].sort((left, right) => left.tillId.localeCompare(right.tillId))[0]?.id;
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
  workspaceId: string | null;
}

/* Why a session did not resolve, for the one caller that has something
   useful to say about it. Everything else takes `resolveSession`, which
   collapses both refusals into "no session" and so cannot be got wrong
   by omission. */
export type SessionState =
  | { state: "none" }
  | { state: "suspended"; user: SessionUser }
  | { state: "active"; user: SessionUser };

/* SUSPENSION IS CHECKED HERE, ON EVERY REQUEST, AND NOT BY DESTROYING SESSIONS.

   Blocking a desk in the platform panel used to set `tenants.suspended` and
   stop there. A new sign-in was refused, and every session already open kept
   full write access until its cookie expired — so a desk blocked at ten in
   the morning for publishing a 9% board went on publishing it all day. The
   panel's own words are "blocking takes a desk offline", and they were false.

   The alternative fix — revoke every session the moment somebody presses
   Block — was rejected twice over. It races: a sign-in that lands a
   millisecond after the revoke sweep, or a suspension applied by anything
   that does not know to sweep (a support script, a restore, the next admin
   route somebody writes), leaves the desk open with nothing to say so. And
   it is destructive in a way blocking is not supposed to be: an operator who
   blocks the wrong desk for ten minutes would have signed out every teller
   mid-shift with drawers open, and unblocking cannot give those sessions
   back. Reading the flag on the way past makes `tenants.suspended` the whole
   truth — offline within one request, and back exactly as it was, cookies
   and all, when the block is lifted. */
export async function resolveSessionState(db: Db, token: string | undefined): Promise<SessionState> {
  if (!token) return { state: "none" };
  const rows = await db
    .select({
      user: schema.staffUsers,
      suspended: schema.tenants.suspended,
      workspaceId: schema.sessions.workspaceId,
    })
    .from(schema.sessions)
    .innerJoin(schema.staffUsers, eq(schema.sessions.userId, schema.staffUsers.id))
    .innerJoin(schema.tenants, eq(schema.staffUsers.tenantId, schema.tenants.id))
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
  if (!row) return { state: "none" };
  const u = row.user;
  const user: SessionUser = {
    id: u.id,
    staffId: u.staffId,
    name: u.name,
    role: u.role,
    tenantId: u.tenantId,
    legalEntityId: u.legalEntityId,
    branchId: u.branchId,
    authorizedBranchIds: u.authorizedBranchIds,
    mustChangePassword: u.mustChangePassword,
    workspaceId: row.workspaceId ?? null,
  };
  return row.suspended ? { state: "suspended", user } : { state: "active", user };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<SessionUser | null> {
  const resolved = await resolveSessionState(db, token);
  return resolved.state === "active" ? resolved.user : null;
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
