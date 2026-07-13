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
  // staff password for the seeded accounts: SEED_PASSWORD env in production
  // (set it in the Render dashboard), "yorkville" for local dev only
  password: process.env.SEED_PASSWORD ?? "yorkville",
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
  // initial rate board publication — factory rates from the prototype's
  // converter (yorkfx-converter.js CUR list). perCad = units per 1 CAD;
  // the board stores mid = CAD per 1 unit, so mid = 1 / perCad.
  const perCad: Record<string, number> = {
    USD: 0.7331, EUR: 0.6798, GBP: 0.5779, CHF: 0.6512, AUD: 1.119, JPY: 109.9,
    CNY: 5.284, INR: 60.31, AED: 2.6926, PHP: 41.15, MXN: 12.42, KRW: 982.4,
    HKD: 5.731, SGD: 0.9912, NZD: 1.2204, HUF: 262.3, TWD: 23.45, DKK: 5.071,
    ILS: 2.701, SEK: 7.842, NOK: 7.815, ZAR: 13.48, BRL: 3.951, THB: 26.38,
    PLN: 2.931, TRY: 23.82, SAR: 2.749, PKR: 204.3,
  };
  const existingBoard = await db.select({ id: schema.rateBoards.id }).from(schema.rateBoards).limit(1);
  if (existingBoard.length === 0) {
    const boardRows: Record<string, { mid: number; show: boolean }> = {};
    for (const [code, units] of Object.entries(perCad)) {
      boardRows[code] = { mid: Number((1 / units).toPrecision(6)), show: true };
    }
    await db.insert(schema.rateBoards).values({
      id: "seed-board-v1",
      tenantId: DEMO.tenantId,
      legalEntityId: DEMO.legalEntityId,
      branchId: DEMO.branchId,
      buyMargin: 0.015,
      sellMargin: 0.015,
      boardRows,
      boardOrder: ["CAD", ...Object.keys(perCad)],
      publishedBy: "seed",
    });
  }

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
