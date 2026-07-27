/* ============================================================
   The CurrencyDesk ID — CD-YORK-0042.

   What a person reads out when they ring for help, and what they sign
   in with. Three parts so it survives being spoken over a phone: the
   prefix says whose it is, the desk code says where they work, and the
   number is theirs.

   Unique across the platform, so support can act on an ID without first
   asking which desk it belongs to. Issued on demand, never on a
   schedule: an account created before the scheme existed keeps signing
   in with its staff id until someone issues one.
   ============================================================ */
import { and, eq, isNotNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

/* Four letters of the desk, upper case, padded if the name is short.
   Letters only: a desk called "24/7 FX" should still read as a word. */
export function deskCode(nameOrSlug: string): string {
  const letters = (nameOrSlug || "").toUpperCase().replace(/[^A-Z]/g, "");
  return (letters || "DESK").slice(0, 4).padEnd(4, "X");
}

const ID_RE = /^CD-[A-Z]{2,6}-\d{4,}$/;
export const looksLikeCdId = (s: string): boolean => ID_RE.test((s || "").trim().toUpperCase());
export const normalizeCdId = (s: string): string => (s || "").trim().toUpperCase();

/* Issue the next id for a desk. Numbers run per desk from 0001 and never
   reuse: reissuing gives someone a new number rather than recycling a
   retired one, so an old ID in an email thread can never resolve to a
   different person later. */
export async function issueCdId(db: Db, tenantId: string): Promise<string> {
  const tenant = (await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];
  if (!tenant) throw new Error(`no such desk: ${tenantId}`);
  const code = deskCode(tenant.siteSlug || tenant.name);

  const taken = await db
    .select({ cdId: schema.staffUsers.cdId })
    .from(schema.staffUsers)
    .where(and(eq(schema.staffUsers.tenantId, tenantId), isNotNull(schema.staffUsers.cdId)));

  // highest number this desk has ever handed out, retired ones included
  let next = 0;
  for (const row of taken) {
    const n = Number(String(row.cdId ?? "").split("-")[2] ?? 0);
    if (Number.isFinite(n) && n > next) next = n;
  }

  /* Another operator could be issuing at the same moment. The unique index
     is the real guard, so try the next few numbers rather than trusting the
     count we just read. */
  for (let i = 1; i <= 25; i++) {
    const candidate = `CD-${code}-${String(next + i).padStart(4, "0")}`;
    const clash = (await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.cdId, candidate)).limit(1))[0];
    if (!clash) return candidate;
  }
  throw new Error("could not issue a CurrencyDesk ID — too many collisions");
}
