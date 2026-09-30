/* Who a sign-in name points at.

   A CurrencyDesk ID identifies a person on its own — that is the point of
   it — so it resolves without being told which desk. An email identity is
   globally unique, so it resolves the tenant on its own. A plain staff id
   is scoped by tenant.

   The desk door and the platform-admin door both call this. Two copies
   would eventually resolve the same typed name to two different people. */
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { looksLikeCdId, normalizeCdId } from "./cdid.js";

export const isEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export async function findStaffForLogin(db: Db, staffId: string, tenantId: string) {
  if (looksLikeCdId(staffId)) {
    const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.cdId, normalizeCdId(staffId))).limit(1);
    return rows[0];
  }
  if (isEmail(staffId)) {
    const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(2);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) return rows.find((r) => r.tenantId === tenantId) ?? rows[0];
    return undefined;
  }
  const rows = await db
    .select()
    .from(schema.staffUsers)
    .where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, staffId)))
    .limit(1);
  return rows[0];
}
