/* ============================================================
   Demo seed — mirrors src/domain/seed.ts on the frontend
   (Yorkville Desk, till-01, j.masri / r.haddad / a.singh) so the
   two sides agree on day one. Demo password for every account:
   "yorkville" (dev only — replace before anything real).
   Idempotent: safe to run repeatedly.
   ============================================================ */
import { createDb, schema } from "./db/index.js";
import { hashPassword } from "./auth/password.js";

export const DEMO = {
  tenantId: "tnt-yorkfx",
  legalEntityId: "le-yorkfx-canada",
  branchId: "br-yorkville",
  workspaceId: "ws-yorkville-till-01",
  password: "yorkville",
};

export async function seed(db: Awaited<ReturnType<typeof createDb>>["db"]) {
  const passwordHash = await hashPassword(DEMO.password);

  await db.insert(schema.tenants).values({ id: DEMO.tenantId, name: "York FX" }).onConflictDoNothing();
  await db
    .insert(schema.legalEntities)
    .values({ id: DEMO.legalEntityId, tenantId: DEMO.tenantId, name: "York Currency Exchange Inc.", msbNumber: "M12345678", jurisdiction: "FINTRAC" })
    .onConflictDoNothing();
  await db
    .insert(schema.branches)
    .values({ id: DEMO.branchId, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, name: "Yorkville Desk" })
    .onConflictDoNothing();
  await db
    .insert(schema.workspaces)
    .values({ id: DEMO.workspaceId, tenantId: DEMO.tenantId, legalEntityId: DEMO.legalEntityId, branchId: DEMO.branchId, tillId: "till-01" })
    .onConflictDoNothing();

  const staff = [
    { staffId: "j.masri", name: "J. Masri", role: "administrator" as const },
    { staffId: "r.haddad", name: "R. Haddad", role: "branch_manager" as const },
    { staffId: "a.singh", name: "A. Singh", role: "teller" as const },
  ];
  for (const s of staff) {
    await db
      .insert(schema.staffUsers)
      .values({
        id: `${DEMO.tenantId}:${s.staffId}`,
        tenantId: DEMO.tenantId,
        legalEntityId: DEMO.legalEntityId,
        branchId: DEMO.branchId,
        staffId: s.staffId,
        name: s.name,
        role: s.role,
        authorizedBranchIds: [DEMO.branchId],
        passwordHash,
      })
      .onConflictDoNothing();
  }
}

// CLI: npm run seed
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const handle = await createDb();
  await seed(handle.db);
  console.log("seeded demo tenant (password: %s)", DEMO.password);
  await handle.close();
}
