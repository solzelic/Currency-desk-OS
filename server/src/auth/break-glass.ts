/* Break-glass password reset.

   RESET_STAFF_PASSWORD="staffId:newpassword" runs once at boot. It is
   how an owner gets back in on the day the lock, or a lost password,
   has shut the desk. The env var is set on the host and then removed;
   this module does not read Render settings, the boot file does.

   The reset also clears the sign-in failure counter for that account.
   A new password that is still refused for fifteen minutes is not a
   recovery. */
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { DEMO } from "../seed.js";
import { hashPassword } from "./password.js";
import { revokeAllSessions } from "./sessions.js";
import { audit } from "../audit.js";
import { clearSignInLock } from "./signin-guard.js";

export async function applyResetStaffPassword(db: Db, raw: string): Promise<"reset" | "missing" | "malformed"> {
  const [staffId, ...rest] = raw.split(":");
  const password = rest.join(":");
  if (!staffId || password.length < 8) {
    console.warn("[break-glass] RESET_STAFF_PASSWORD malformed — expected staffId:password (password ≥ 8 chars)");
    return "malformed";
  }
  const rows = await db
    .select()
    .from(schema.staffUsers)
    .where(and(
      eq(schema.staffUsers.tenantId, DEMO.tenantId),
      sql`lower(${schema.staffUsers.staffId}) = ${staffId.trim().toLowerCase()}`,
    ))
    .limit(1);
  const user = rows[0];
  if (!user) {
    console.warn(`[break-glass] RESET_STAFF_PASSWORD set but staff id "${staffId}" not found`);
    return "missing";
  }
  await db
    .update(schema.staffUsers)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: true, passwordUpdatedAt: new Date(), active: true })
    .where(eq(schema.staffUsers.id, user.id));
  await revokeAllSessions(db, user.id);
  await clearSignInLock(db, user.id);
  await audit(db, {
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    actorId: null,
    action: "staff.password_reset",
    detail: { staffId: user.staffId, via: "RESET_STAFF_PASSWORD env (break-glass)" },
  });
  console.warn(`[break-glass] password reset for ${user.staffId} — REMOVE the RESET_STAFF_PASSWORD env var now`);
  return "reset";
}
