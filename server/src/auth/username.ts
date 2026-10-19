/* ============================================================
   The username — amir.yorkfx.

   What a teller types at the counter. Two parts: their first name, and
   the shop's handle. The shop is in the name so the name finds its desk
   on its own. The sign-in page does not say which desk it is on, and a
   bare "a.singh" could belong to anybody.

   Free on every desk, not only this one. That is what lets sign-in find
   the desk from the name alone (auth/login-user.ts). Usernames from
   before the scheme ("a.singh" at York) keep working: sign-in looks at
   the desk first, and only then everywhere.

   The server picks it and the server checks it. The screen shows the
   suggestion while the manager types a name, and may send a different
   one; the create route checks that one the same way. Only the server
   can see the other desks.

   Two creates of the same name at two desks in the same instant can
   both pass the check. There is no unique index across desks to stop
   it, because older ids may already repeat across desks. If it happens,
   sign-in finds two and treats the name as unknown, so nobody signs in
   to the wrong desk.
   ============================================================ */
import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

/* Letters and digits only, accents folded: "José" is "jose". */
function fold(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/* The shop's part. Its site handle when it has one (yorkfx), otherwise
   its name, folded. Capped so a long name does not make a username
   nobody wants to type. */
export function shopHandle(tenant: { siteSlug: string | null; name: string }): string {
  return (fold(tenant.siteSlug ?? "") || fold(tenant.name) || "desk").slice(0, 16);
}

/* "Amir Singh" is first "amir", last initial "s". A name with no Latin
   letters folds to nothing and becomes "staff". */
export function nameParts(name: string): { first: string; initial: string } {
  const words = (name || "").trim().split(/\s+/).map(fold).filter(Boolean);
  const first = (words[0] || "staff").slice(0, 20);
  const initial = words.length > 1 ? words[words.length - 1]!.slice(0, 1) : "";
  return { first, initial };
}

/* In use anywhere on the platform. Case-folded, the same way sign-in and
   the failure counter fold a typed id. */
export async function usernameTaken(db: Db, staffId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.staffUsers.id })
    .from(schema.staffUsers)
    .where(sql`lower(${schema.staffUsers.staffId}) = ${staffId.trim().toLowerCase()}`)
    .limit(1);
  return rows.length > 0;
}

/* The first free one of: amir.yorkfx, then amirs.yorkfx (last initial),
   then amir2.yorkfx, amir3.yorkfx, and on. */
export async function suggestUsername(db: Db, tenantId: string, name: string): Promise<string> {
  const tenant = (await db
    .select({ siteSlug: schema.tenants.siteSlug, name: schema.tenants.name })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1))[0];
  if (!tenant) throw new Error(`no such desk: ${tenantId}`);
  const shop = shopHandle(tenant);
  const { first, initial } = nameParts(name);

  const candidates = [`${first}.${shop}`];
  if (initial) candidates.push(`${first}${initial}.${shop}`);
  for (let n = 2; n <= 99; n++) candidates.push(`${first}${n}.${shop}`);
  for (const candidate of candidates) {
    if (!(await usernameTaken(db, candidate))) return candidate;
  }
  throw new Error("could not find a free username");
}
