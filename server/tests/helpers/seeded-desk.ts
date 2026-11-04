/* The demo desk as the seed makes it: one branch, one till. A file that
   opens more locations or tills on it calls this before it starts and
   after it ends, so the next file finds the seeded desk and not a branch
   in another zone or a session pointing at a till that is gone.

   Children go first: a session still pointing at a till blocks deleting
   that till. Ledger rows are left alone, because several files leave
   ledger state on purpose. */
import type pg from "pg";
import { DEMO } from "../../src/seed.js";

export async function backToSeededDesk(pool: pg.Pool): Promise<void> {
  const desk = [DEMO.tenantId, DEMO.branchId, DEMO.workspaceId];
  const extraStaff = "SELECT id FROM staff_users WHERE tenant_id=$1 AND branch_id<>$2";
  const extraTills = "SELECT id FROM workspaces WHERE tenant_id=$1 AND id<>$3";
  await pool.query(`DELETE FROM sessions WHERE user_id IN (${extraStaff}) OR workspace_id IN (${extraTills})`, desk);
  await pool.query(`DELETE FROM login_challenges WHERE user_id IN (${extraStaff})`, desk.slice(0, 2));
  await pool.query(`DELETE FROM password_resets WHERE user_id IN (${extraStaff})`, desk.slice(0, 2));
  await pool.query("DELETE FROM staff_users WHERE tenant_id=$1 AND branch_id<>$2", desk.slice(0, 2));
  await pool.query("DELETE FROM rate_boards WHERE tenant_id=$1 AND branch_id<>$2", desk.slice(0, 2));
  await pool.query("DELETE FROM workspaces WHERE tenant_id=$1 AND id<>$2", [DEMO.tenantId, DEMO.workspaceId]);
  /* Opening a branch adds it to the owner's own list. Take the gone ones off. */
  const gone = await pool.query<{ id: string }>("DELETE FROM branches WHERE tenant_id=$1 AND id<>$2 RETURNING id", desk.slice(0, 2));
  if (gone.rows.length) {
    await pool.query("UPDATE staff_users SET authorized_branch_ids = authorized_branch_ids - $2::text[] WHERE tenant_id=$1", [
      DEMO.tenantId,
      gone.rows.map((row) => row.id),
    ]);
  }
}
