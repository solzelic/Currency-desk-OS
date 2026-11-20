/* Who a sign-in name points at.

   A CurrencyDesk ID identifies a person on its own — that is the point of
   it — so it resolves without being told which desk. An email identity is
   globally unique, so it resolves the tenant on its own. A plain staff id
   is looked up at the desk. A username (amir.yorkfx) is free on every
   desk, so a caller that does not name a desk — the sign-in page, which
   does not know which desk it is on — passes `anywhere`, and a name the
   default desk does not have is then looked up on every desk. A caller
   that names a desk gets that desk only.

   The desk door and the platform-admin door both call this. Two copies
   would eventually resolve the same typed name to two different people. */
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { looksLikeCdId, normalizeCdId } from "./cdid.js";
import { CD_ID_RE } from "../enquiries/cd-id.js";

export const isEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/* The failure counter folds the typed id to lower case. The lookup has
   to do the same, or "R.Limit" and "r.limit" are two people: one of them
   a miss, and the lock on the real account never sees the other. */
const sameStaffId = (typed: string) => sql`lower(${schema.staffUsers.staffId}) = ${typed.trim().toLowerCase()}`;

export async function findStaffForLogin(db: Db, staffId: string, tenantId: string, opts: { anywhere?: boolean } = {}) {
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
  if (rows[0] || !opts.anywhere) return rows[0];
  /* Only a name that exists once resolves. Two desks holding the same
     older id is ambiguous, and ambiguous is a miss: signing somebody in
     to the wrong desk is worse than not signing them in. */
  const anywhere = await db.select().from(schema.staffUsers).where(sameStaffId(staffId)).limit(2);
  return anywhere.length === 1 ? anywhere[0] : undefined;
}

/** Returning desk login adds only the unambiguous, fully spelled v2 ID.
 * Keep the platform door and legacy username resolver unchanged. Compact
 * and prefix-free spellings overlap legal usernames; CTO policy is pending. */
export async function findReturningStaff(db: Db, identifier: string, tenantId: string, anywhere = false) {
  if (!CD_ID_RE.test(normalizeCdId(identifier))) return findStaffForLogin(db, identifier, tenantId, { anywhere });
  // A full ID must not select a different desk through a legacy username.
  // Resolve the union; two distinct people are a miss, never a precedence rule.
  const matches = await db.select().from(schema.staffUsers).where(or(
    eq(schema.staffUsers.cdId, normalizeCdId(identifier)), sameStaffId(identifier),
  )).limit(2);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Enrolment candidates never authorize a returning sign-in. The activation
 * contract binds CD-ID, enquiry, onboarding tenant and the provisioned owner.
 * Use the current staff hash, not the enrolment copy: resets change it. A
 * contact email alone is not ownership and is never used as an alias. */
export async function returningPasswordEligible(db: Db, user: typeof schema.staffUsers.$inferSelect | undefined): Promise<boolean> {
  if (!user?.active) return false;
  if (!user.cdId) return true; // established legacy staff account
  const rows = await db.select({ account: schema.signupAccounts, enquiry: schema.enquiries, onboarding: schema.onboarding })
    .from(schema.enquiries)
    .leftJoin(schema.signupAccounts, eq(schema.signupAccounts.enquiryId, schema.enquiries.id))
    .leftJoin(schema.onboarding, eq(schema.onboarding.enquiryId, schema.enquiries.id))
    .where(eq(schema.enquiries.cdId, user.cdId)).limit(1);
  const row = rows[0];
  if (!row) return true; // staff-issued legacy ID, not a signup reservation
  if (row.account?.state !== "active" || !row.account.emailVerifiedAt
    || row.enquiry.tenantId !== user.tenantId || row.onboarding?.tenantId !== user.tenantId
    || row.enquiry.email.trim().toLowerCase() !== user.staffId.trim().toLowerCase()
    || user.id !== `${user.tenantId}:${row.enquiry.email.trim().toLowerCase()}`) return false;
  const credential = await db.select({ id: schema.signupCredentials.id }).from(schema.signupCredentials).where(and(
    eq(schema.signupCredentials.enquiryId, row.enquiry.id), eq(schema.signupCredentials.kind, "password"),
    isNotNull(schema.signupCredentials.verifiedAt), isNotNull(schema.signupCredentials.passwordHash),
  )).limit(1);
  return credential.length === 1;
}
