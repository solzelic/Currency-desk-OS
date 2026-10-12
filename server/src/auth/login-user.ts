/* Who a sign-in name points at.

   A CurrencyDesk ID identifies a person on its own — that is the point of
   it — so it resolves without being told which desk. An email identity is
   globally unique, so it resolves the tenant on its own. A plain staff id
   is scoped by tenant.

   The desk door and the platform-admin door both call this. Two copies
   would eventually resolve the same typed name to two different people. */
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { looksLikeCdId, normalizeCdId } from "./cdid.js";

export const isEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/* The failure counter folds the typed id to lower case. The lookup has
   to do the same, or "R.Limit" and "r.limit" are two people: one of them
   a miss, and the lock on the real account never sees the other. */
const sameStaffId = (typed: string) => sql`lower(${schema.staffUsers.staffId}) = ${typed.trim().toLowerCase()}`;

export async function findStaffForLogin(db: Db, staffId: string, tenantId: string) {
  if (looksLikeCdId(staffId)) {
    const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.cdId, normalizeCdId(staffId))).limit(1);
    return rows[0];
  }
  if (isEmail(staffId)) {
    const rows = await db.select().from(schema.staffUsers).where(sameStaffId(staffId)).limit(2);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) return rows.find((r) => r.tenantId === tenantId) ?? rows[0];
    return undefined;
  }
  const rows = await db
    .select()
    .from(schema.staffUsers)
    .where(and(eq(schema.staffUsers.tenantId, tenantId), sameStaffId(staffId)))
    .limit(1);
  return rows[0];
}
