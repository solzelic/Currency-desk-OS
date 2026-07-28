import type pg from "pg";
import type { BackendPermission } from "../auth/permissions.js";
import { hasBackendPermission } from "../auth/permissions.js";
import { LedgerError, type LedgerActor } from "./service.js";

const scope = (actor: LedgerActor) => [
  actor.tenantId,
  actor.legalEntityId,
  actor.branchId,
  actor.workspaceId,
  actor.tillId,
];

/**
 * Mirror the authenticated staff record into the ledger authorization
 * boundary. The auth database remains authoritative for role and branch
 * access; a stale ledger row can never grant permissions.
 */
export async function ensureLedgerPrincipal(pool: pg.Pool, actor: LedgerActor) {
  await pool.query(
    `INSERT INTO ledger_principals
      (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id,role,authorized_branch_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id,tenant_id,legal_entity_id,branch_id,workspace_id,till_id)
     DO UPDATE SET role=EXCLUDED.role, authorized_branch_ids=EXCLUDED.authorized_branch_ids`,
    [
      actor.userId,
      ...scope(actor),
      actor.role,
      JSON.stringify(actor.authorizedBranchIds),
    ],
  );
}

export async function authorizeLedgerActor(
  client: pg.PoolClient,
  actor: LedgerActor,
  permission: BackendPermission,
) {
  const found = await client.query(
    `SELECT role,authorized_branch_ids
       FROM ledger_principals
      WHERE user_id=$1 AND tenant_id=$2 AND legal_entity_id=$3
        AND branch_id=$4 AND workspace_id=$5 AND till_id=$6
      FOR UPDATE`,
    [actor.userId, ...scope(actor)],
  );
  if (!found.rowCount) {
    throw new LedgerError(
      "SCOPE_DENIED",
      "Authenticated principal is outside this workspace.",
    );
  }
  const principal = found.rows[0] as {
    role: string;
    authorized_branch_ids: string[];
  };
  if (
    !hasBackendPermission(principal.role, permission) ||
    !principal.authorized_branch_ids.includes(actor.branchId)
  ) {
    throw new LedgerError("AUTHORIZATION_DENIED", `Missing ${permission}.`);
  }
}
