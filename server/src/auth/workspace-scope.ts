/* ============================================================
   Which till a request is for.

   Tenant, legal entity and branch come only from the session. The
   workspace may be named (`x-workspace-id`) and, when it is not, the
   session's own workspace is used. That workspace is stamped at sign-in
   (first till at the user's home branch, by till id) and updated when
   the operator moves drawers (`POST /api/ledger/till-selection`).

   The previous rule — "the only workspace at this branch, else deny" —
   made adding a till through the product's own route a denial for every
   caller that omitted the header. A second counter must not do that.
   A named workspace that is missing or out of scope is still
   SCOPE_DENIED; it never falls back to a different till.
   ============================================================ */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { setSessionWorkspace, type SessionUser } from "./sessions.js";

export type WorkspaceRow = typeof schema.workspaces.$inferSelect;

export async function workspacesAtBranch(
  db: Db,
  user: Pick<SessionUser, "tenantId" | "legalEntityId" | "branchId">,
): Promise<WorkspaceRow[]> {
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.tenantId, user.tenantId),
        eq(schema.workspaces.legalEntityId, user.legalEntityId),
        eq(schema.workspaces.branchId, user.branchId),
      ),
    );
  return [...rows].sort((left, right) => left.tillId.localeCompare(right.tillId));
}

export async function resolveWorkspaceForUser(
  db: Db,
  user: SessionUser,
  header: string | string[] | undefined,
  token?: string,
): Promise<WorkspaceRow | undefined> {
  if (Array.isArray(header)) return undefined;
  if (!user.authorizedBranchIds.includes(user.branchId)) return undefined;

  const candidates = await workspacesAtBranch(db, user);
  const inScope = (workspace: WorkspaceRow | undefined) =>
    workspace && user.authorizedBranchIds.includes(workspace.branchId) ? workspace : undefined;

  if (header) return inScope(candidates.find((workspace) => workspace.id === header));

  const held = inScope(
    user.workspaceId ? candidates.find((workspace) => workspace.id === user.workspaceId) : undefined,
  );
  if (held) return held;

  const fallback = inScope(candidates[0]);
  if (!fallback) return undefined;
  if (token && fallback.id !== user.workspaceId) {
    await setSessionWorkspace(db, token, fallback.id);
  }
  return fallback;
}
