/* Writes the schedule a new desk starts with. The text lives in
   tenantState so a signup and migration 045 cannot drift apart. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { CHEQUE_FEE_SCHEDULE_KEY } from "../auth/settingsWrite.js";
import { DEFAULT_CHEQUE_SCHEDULE } from "../routes/tenantState.js";

/* Missing: no value, null, "", "[]", or anything that is not a
   non-empty JSON array. A stored 0% schedule is an array, so it
   stays. */
export function chequeScheduleMissing(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") {
    if (value === "" || value === "[]") return true;
    try {
      const parsed = JSON.parse(value) as unknown;
      return !Array.isArray(parsed) || parsed.length === 0;
    } catch {
      return true;
    }
  }
  if (Array.isArray(value)) return value.length === 0;
  return true;
}

/* The value the audit stores as `before`. No row, no key, and JSON null
   are null. A blank, "[]", or unreadable text is that text. */
function scheduleBefore(state: Record<string, unknown>): unknown {
  if (!(CHEQUE_FEE_SCHEDULE_KEY in state)) return null;
  const value = state[CHEQUE_FEE_SCHEDULE_KEY];
  return value == null ? null : value;
}

/* Same row shape as migration 045. Actor is the boot, not the migration. */
async function auditScheduleFill(db: Db, tenantId: string, before: unknown, after: string): Promise<void> {
  const legal = (await db.select({ id: schema.legalEntities.id }).from(schema.legalEntities).where(eq(schema.legalEntities.tenantId, tenantId)).limit(1))[0];
  const branch = (await db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).limit(1))[0];
  await audit(db, {
    tenantId,
    legalEntityId: legal?.id ?? "-",
    branchId: branch?.id ?? "-",
    actorId: "system seed",
    action: "cheque.schedule_backfill",
    detail: { before, after },
  });
}

/* Writes the default only when this desk has no schedule. A retry,
   and a later boot of York FX, leave a real schedule alone. Filling
   a missing one writes one audit row. A schedule already stored
   writes none. */
export async function ensureDefaultChequeSchedule(db: Db, tenantId: string): Promise<void> {
  const schedule = JSON.stringify(DEFAULT_CHEQUE_SCHEDULE);
  const row = (await db.select().from(schema.tenantState).where(eq(schema.tenantState.tenantId, tenantId)).limit(1))[0];
  if (!row) {
    const inserted = await db.insert(schema.tenantState).values({
      tenantId,
      state: { [CHEQUE_FEE_SCHEDULE_KEY]: schedule },
      version: 0,
    }).onConflictDoNothing().returning();
    if (inserted.length) await auditScheduleFill(db, tenantId, null, schedule);
    return;
  }
  const state = row.state ?? {};
  if (!chequeScheduleMissing(state[CHEQUE_FEE_SCHEDULE_KEY])) return;
  const before = scheduleBefore(state);
  await db.update(schema.tenantState).set({
    state: { ...state, [CHEQUE_FEE_SCHEDULE_KEY]: schedule },
    version: row.version + 1,
    updatedAt: new Date(),
  }).where(eq(schema.tenantState.tenantId, tenantId));
  await auditScheduleFill(db, tenantId, before, schedule);
}
