/* ============================================================
   Platform-admin bootstrap. PLATFORM_ADMIN_BOOTSTRAP="email:password"
   ensures a platform-operator account exists (in its own hidden tenant)
   so you can sign in to /admin on a fresh deploy. Re-runs on every boot:
   it (re)sets the password to the configured value — treat it like the
   break-glass RESET_STAFF_PASSWORD and REMOVE it from the environment
   once you've signed in and set a real password.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema } from "./db/index.js";
import type { Db } from "./db/index.js";
import { hashPassword } from "./auth/password.js";

// the operator's own tenant — hidden from the customer desk list
export const PLATFORM_TENANT = "tnt-platform";

export async function ensurePlatformAdmin(db: Db, email: string, password: string): Promise<void> {
  const tenantId = PLATFORM_TENANT;
  const legalEntityId = "le-platform";
  const branchId = "br-platform";
  const workspaceId = "ws-platform-till";
  await db.insert(schema.tenants).values({ id: tenantId, name: "CurrencyDesk Platform", plan: "premium", siteSlug: "platform" }).onConflictDoNothing();
  await db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: "CurrencyDesk", jurisdiction: "FINTRAC" }).onConflictDoNothing();
  await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "HQ" }).onConflictDoNothing();
  await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" }).onConflictDoNothing();
  const id = `${tenantId}:${email}`;
  const passwordHash = await hashPassword(password);
  const existing = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.id, id)).limit(1);
  if (existing.length) {
    await db.update(schema.staffUsers).set({ passwordHash, active: true, mustChangePassword: false, passwordUpdatedAt: new Date() }).where(eq(schema.staffUsers.id, id));
  } else {
    await db.insert(schema.staffUsers).values({ id, tenantId, legalEntityId, branchId, staffId: email, name: "Platform Admin", role: "administrator", authorizedBranchIds: [branchId], passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date() });
  }
}
