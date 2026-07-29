/* ============================================================
   Who runs CurrencyDesk, and what each of them may do.

   This used to be an environment variable — a comma-separated list of
   emails, re-read on every request. That is fine for exactly one person
   and cannot grow: an env var has no roles, no record of who added whom,
   nothing to suspend, and it resets to whatever the deploy config says
   every time the service restarts. A password living in
   PLATFORM_ADMIN_BOOTSTRAP is the same problem wearing a different hat.

   So the platform team is a table, and the env vars become what they
   should always have been: a way to seed the first owner into an empty
   database, ignored once somebody is there.

   THE OWNER IS PROTECTED ON PURPOSE

   Full control must not mean one leaked password ends the company. The
   owner cannot be demoted, suspended or removed through this API — not
   by anyone, including themselves. Locking yourself out of your own
   platform at 2am is a real way to lose a weekend, and an attacker who
   takes a support account should not be able to lock out the person who
   could stop them.

   ROLES ARE FIXED, NOT BUILT

   Six of them, chosen because they are the six jobs. A custom role
   builder is a thing you want at fifty people and a liability at one:
   every permission becomes a question nobody has the context to answer,
   and the answers drift.
   ============================================================ */
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

export type PlatformRole = "owner" | "support" | "billing" | "security" | "privacy" | "auditor";

/* What a permission actually gates. Named for the job rather than the
   endpoint, so a route asking for one reads as a sentence. */
export type Permission =
  | "desks:read" | "desks:write"
  | "applications:read" | "applications:write"
  | "billing:read" | "billing:write"
  | "people:read" | "people:write"
  | "team:manage"
  | "security:manage"
  | "privacy:manage"
  | "audit:read";

const ALL: Permission[] = [
  "desks:read", "desks:write", "applications:read", "applications:write",
  "billing:read", "billing:write", "people:read", "people:write",
  "team:manage", "security:manage", "privacy:manage", "audit:read",
];

export const ROLES: { id: PlatformRole; title: string; blurb: string; permissions: Permission[] }[] = [
  {
    id: "owner", title: "Platform Owner",
    blurb: "Everything, everywhere. Cannot be removed, demoted or suspended from in here.",
    permissions: ALL,
  },
  {
    id: "support", title: "Support",
    blurb: "Helps customers: reads desks and people, works applications, cannot touch money or the team.",
    permissions: ["desks:read", "desks:write", "applications:read", "applications:write", "people:read", "people:write", "audit:read"],
  },
  {
    id: "billing", title: "Billing Operations",
    blurb: "Subscriptions, invoices, failed payments and promotion codes. Reads desks for context.",
    permissions: ["billing:read", "billing:write", "desks:read", "audit:read"],
  },
  {
    id: "security", title: "Security Incident Responder",
    blurb: "Sessions, lockouts and suspensions when something is wrong. Cannot move money.",
    permissions: ["security:manage", "desks:read", "desks:write", "people:read", "people:write", "audit:read"],
  },
  {
    id: "privacy", title: "Privacy & Compliance",
    blurb: "Privacy requests, legal holds, retention and controlled exports.",
    permissions: ["privacy:manage", "desks:read", "people:read", "audit:read"],
  },
  {
    id: "auditor", title: "Read-only Auditor",
    blurb: "Can see, and change nothing. For anybody who needs the picture without the ability to alter it.",
    permissions: ["desks:read", "applications:read", "billing:read", "people:read", "audit:read"],
  },
];

const BY_ROLE = new Map(ROLES.map((r) => [r.id, new Set(r.permissions)]));
export const can = (role: PlatformRole | undefined, p: Permission): boolean =>
  !!role && !!BY_ROLE.get(role)?.has(p);

export type Member = typeof schema.platformUsers.$inferSelect;

export const isOwner = (m: Member | null | undefined): boolean => m?.role === "owner";

/* The team, from the table. Suspended members are still rows — you want to
   see that somebody was turned off rather than that they vanished. */
export async function member(db: Db, email: string | undefined): Promise<Member | null> {
  if (!email) return null;
  const key = email.toLowerCase();
  let rows = await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, key)).limit(1);
  if (!rows[0]) {
    /* An empty table is the bootstrap case, and it is the ONLY case the env
       vars still speak to. Seed on first sight rather than only at boot, so
       a database restored from backup — or a test that builds the app
       directly — comes up with its owner rather than locked out. Once
       somebody is in the table this never runs again, which is what stops a
       stale deploy config handing access back to an address you removed. */
    await seedOwner(db);
    rows = await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, key)).limit(1);
  }
  const m = rows[0];
  if (!m || m.status !== "active") return null;
  return m;
}

/* First boot only. PLATFORM_ADMIN_EMAILS names the owner; whichever comes
   first wins and nothing overwrites it afterwards, so a stale deploy config
   cannot quietly hand control back to an address you have since removed. */
export async function seedOwner(db: Db): Promise<void> {
  const existing = await db.select({ email: schema.platformUsers.email }).from(schema.platformUsers).limit(1);
  if (existing.length) return;

  const boot = process.env.PLATFORM_ADMIN_BOOTSTRAP?.split(":")[0]?.trim().toLowerCase();
  const listed = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const owner = boot || listed[0];
  if (!owner) return;

  await db.insert(schema.platformUsers).values({
    email: owner, name: null, role: "owner", status: "active", addedBy: "bootstrap",
  }).onConflictDoNothing();
  /* Anybody else in the list starts as support rather than owner. There is
     one owner; the rest are people who were given access. */
  for (const e of listed.filter((e) => e !== owner)) {
    await db.insert(schema.platformUsers).values({
      email: e, name: null, role: "support", status: "active", addedBy: "bootstrap",
    }).onConflictDoNothing();
  }
  console.log(`[platform] seeded ${owner} as Platform Owner`);
}

/* Why a change to a member is or is not allowed. Returned as a reason
   rather than a boolean so the panel can say what the rule is instead of
   greying a button out with no explanation. */
export function refuseChange(actor: Member, target: Member, change: "role" | "status" | "remove"): string | null {
  if (!can(actor.role as PlatformRole, "team:manage")) return "Only the owner can change the team.";
  if (target.role === "owner") {
    return change === "role"
      ? "The owner's role cannot be changed. Full control has to survive a bad day."
      : change === "status"
        ? "The owner cannot be suspended — including by the owner."
        : "The owner cannot be removed.";
  }
  if (actor.email === target.email && change !== "role") return "You cannot do that to your own account.";
  return null;
}
