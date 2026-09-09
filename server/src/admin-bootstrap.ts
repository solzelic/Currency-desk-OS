/* ============================================================
   Platform-admin bootstrap. PLATFORM_ADMIN_BOOTSTRAP="email:password"
   creates a platform-operator account (in its own hidden tenant) so you
   can sign in to /admin on a fresh deploy. One-shot: if the account
   already exists, tenant scaffolding is still ensured but passwordHash,
   mustChangePassword, and passwordUpdatedAt are left alone. Remove the
   env var from Render after first sign-in — while it is set the
   plaintext lives in the host environment.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema } from "./db/index.js";
import { packForCountry } from "./ledger/jurisdiction.js";
import type { Db } from "./db/index.js";
import { hashPassword } from "./auth/password.js";

// the operator's own tenant — hidden from the customer desk list
export const PLATFORM_TENANT = "tnt-platform";

export async function ensurePlatformAdmin(db: Db, email: string, password: string): Promise<"created" | "exists"> {
  const tenantId = PLATFORM_TENANT;
  const legalEntityId = "le-platform";
  const branchId = "br-platform";
  const workspaceId = "ws-platform-till";
  await db.insert(schema.tenants).values({ id: tenantId, name: "CurrencyDesk Platform", plan: "premium", siteSlug: "platform" }).onConflictDoNothing();
  await db.insert(schema.legalEntities).values({ id: legalEntityId, tenantId, name: "CurrencyDesk", homeCurrency: packForCountry("CA").homeCurrency, jurisdictionPackId: packForCountry("CA").packId, jurisdictionPackVersion: 1, jurisdiction: "FINTRAC" }).onConflictDoNothing();
  await db.insert(schema.branches).values({ id: branchId, tenantId, legalEntityId, name: "HQ" }).onConflictDoNothing();
  await db.insert(schema.workspaces).values({ id: workspaceId, tenantId, legalEntityId, branchId, tillId: "till-01" }).onConflictDoNothing();
  const id = `${tenantId}:${email}`;
  const existing = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.id, id)).limit(1);
  if (existing.length) {
    return "exists";
  }
  const passwordHash = await hashPassword(password);
  await db.insert(schema.staffUsers).values({ id, tenantId, legalEntityId, branchId, staffId: email, name: "Platform Admin", role: "administrator", authorizedBranchIds: [branchId], passwordHash, mustChangePassword: false, passwordUpdatedAt: new Date() });
  return "created";
}
