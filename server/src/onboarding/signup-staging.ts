/* ============================================================
   Sign-up v2.1 on staging: the synthetic shop the staging door minted
   (routes/staging-fresh-shop.ts, POST /api/staging/fresh-onboarding).

   Such a shop has no inbox and must never reach a card processor, so two
   things change for it, and only for it:
     - the 6-digit email code is handed back to the browser that saved the
       credential, instead of being mailed (routes/signup-credential.ts,
       routes/signup-email.ts). The code itself is the ordinary one: same
       generator, hash, 10 minutes, 5 tries, 3 sends per 15 minutes;
     - the desk opens without a card (routes/signup-desk.ts, staging-open),
       through the same assent and activation as a paid desk, as a test shop.

   Every gate is required, read fresh on every request, and anything that
   throws closes it:
     1. stagingDoorOpen on the raw Host header: STAGING exactly "1", a staging
        RENDER_EXTERNAL_HOSTNAME, a staging request Host. x-forwarded-host and
        Forwarded are never a host;
     2. the database says it is staging: exactly one db_environment row,
        'staging' (insert-only, written by `npm run staging -- mark-db`);
     3. the reservation is the door's own: details.stagingFresh and the
        do-not-contact reason are written by the server from the ticket
        (routes/enquiries.ts), and the email and slug carry the same 8-hex id
        freshIdentity() minted. A public application cannot set any of them.
   ============================================================ */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { stagingDoorOpen, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import { isStagingDoorEnquiry } from "../routes/early-access.js";

type Enquiry = typeof schema.enquiries.$inferSelect;

const FIXTURE_EMAIL = /^owner\+([0-9a-f]{8})@staging\.invalid$/;

/** The reservation's own markers, without the runtime: server-written only. */
export function stagingFixtureRow(row: Pick<Enquiry, "email" | "details" | "doNotContact" | "doNotContactReason">): boolean {
  const id = FIXTURE_EMAIL.exec(row.email)?.[1];
  const d = row.details ?? {};
  return !!id && d.stagingFresh === true && d.slug === `stg-${id}` && isStagingDoorEnquiry(row);
}

/** Exactly one db_environment row, and it says staging. No table, no row, more than one, or an error: not staging. */
export async function databaseMarkedStaging(db: Db): Promise<boolean> {
  try {
    if (!(await db.execute(sql`SELECT to_regclass('public.db_environment') IS NOT NULL AS ok`)).rows[0]?.ok) return false;
    const rows = (await db.execute(sql`SELECT environment FROM db_environment`)).rows;
    return rows.length === 1 && rows[0]?.environment === "staging";
  } catch {
    return false; // unreadable means closed
  }
}

/** All three gates for this request and this reservation. */
export async function stagingSignupFixture(db: Db, row: Enquiry, headers: StagingDoorHeaders, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!stagingDoorOpen({ host: headers.host }, env)) return false;
  if (!stagingFixtureRow(row)) return false;
  return databaseMarkedStaging(db);
}

/** For the returning sign-in (CD221): is this staff user the owner the staging
    door's synthetic shop activated? Every gate above, plus the activation's
    own correlation: an accepted reservation bound to this tenant, whose email
    is this staff id and whose stg- slug is this tenant's site slug, on a test
    shop. Anything else, or any error, is false. */
export async function stagingFixtureOwner(db: Db, headers: StagingDoorHeaders, staffId: string, tenantId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    if (!stagingDoorOpen({ host: headers.host }, env)) return false;
    const email = staffId.trim().toLowerCase();
    if (!FIXTURE_EMAIL.test(email)) return false;
    const tenant = (await db.select({ isTestShop: schema.tenants.isTestShop, siteSlug: schema.tenants.siteSlug })
      .from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
    if (tenant?.isTestShop !== true) return false;
    const rows = await db.select().from(schema.enquiries)
      .where(and(eq(schema.enquiries.tenantId, tenantId), eq(schema.enquiries.email, email), eq(schema.enquiries.status, "accepted"))).limit(2);
    if (rows.length !== 1 || !stagingFixtureRow(rows[0]!) || rows[0]!.details?.slug !== tenant.siteSlug) return false;
    return databaseMarkedStaging(db);
  } catch {
    return false;
  }
}
