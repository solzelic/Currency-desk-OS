/* ============================================================
   Is this shop address free? (Early Access v2.1, step 2; CD-178.)

     GET /api/workspaces/:slug → { slug, available, suggestions[] }

   The application asks for the shop's address on CurrencyDesk,
   `<slug>.currencydeskos.com`, and checks it while the person types
   (the page waits about 450 ms after the last key). An address is taken
   when:
     · a desk already uses it (tenants.site_slug),
     · a sign-up in progress holds it (pending_signups.slug), or
     · another application asked for it and was not declined
       (enquiries.details.workspace, the full host or the bare slug).
   A reserved word is never free.

   The suggestions are the design's, worked out here so they are only
   ever free ones: the words joined, the name plus "-exchange", the
   initials plus "fx", the name plus "-ca", the first word plus "fx". Up
   to three. The page shows them as AVAILABLE when the address is taken
   and ALSO AVAILABLE when it is free.

   Nothing is held by asking. Public, no sign-in, never cached (the app's
   API rule in app.ts sends no-store on every /api answer), and slowed per
   client address so it cannot be used to walk the list of
   every shop on the platform quickly.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, ne, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { clientIp } from "../auth/client-ip.js";
import { slugTaken } from "../onboarding/provision.js";
import { isReservedSlug, slugShape } from "../onboarding/reserved-slugs.js";

export const SITE_HOST = "currencydeskos.com";
/* Typing pauses produce about one check a second at most; sixty a minute
   covers a person and stops a script. */
export const WORKSPACE_CHECKS_PER_MINUTE = 60;
/* The page's own limit for an address it fills in from the shop name. */
const SUGGESTION_MAX = 30;

const checks = new Map<string, number[]>();

/* For tests, which reuse one server. */
export function resetWorkspaceThrottle(): void {
  checks.clear();
}

function allow(key: string): boolean {
  const now = Date.now();
  const hits = (checks.get(key) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= WORKSPACE_CHECKS_PER_MINUTE) {
    checks.set(key, hits);
    return false;
  }
  hits.push(now);
  checks.set(key, hits);
  return true;
}

/* Another application asked for it. A declined one holds nothing. */
async function heldByApplication(db: Db, slug: string): Promise<boolean> {
  const host = `${slug}.${SITE_HOST}`;
  const rows = await db
    .select({ id: schema.enquiries.id })
    .from(schema.enquiries)
    .where(and(
      ne(schema.enquiries.status, "declined"),
      sql`lower(${schema.enquiries.details} ->> 'workspace') in (${host}, ${slug})`,
    ))
    .limit(1);
  return rows.length > 0;
}

export async function workspaceTaken(db: Db, slug: string): Promise<boolean> {
  if (isReservedSlug(slug)) return true;
  if (await slugTaken(db, slug)) return true;
  return heldByApplication(db, slug);
}

/* The design's alternatives, in its order, before any is checked. */
export function workspaceIdeas(slug: string, jurisdiction = "ca"): string[] {
  const words = slug.split("-").filter(Boolean);
  const out: string[] = [];
  const add = (raw: string) => {
    const idea = raw.replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, SUGGESTION_MAX).replace(/-$/, "");
    if (idea.length >= 2 && idea !== slug && !out.includes(idea)) out.push(idea);
  };
  add(words.join(""));
  if (!words.includes("exchange")) add(`${slug}-exchange`);
  if (words.length > 1) add(`${words.map((w) => w[0]).join("")}fx`);
  add(`${slug}-${jurisdiction}`);
  if (words[0]) add(`${words[0]}fx`);
  return out;
}

export function registerWorkspaceRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/workspaces/:slug", async (req, reply) => {
    const parsed = slugShape.safeParse((req.params as { slug?: unknown }).slug);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_slug" });
    if (!allow(clientIp(req))) return reply.code(429).send({ error: "slow_down" });
    const slug = parsed.data;
    const available = !(await workspaceTaken(db, slug));
    const suggestions: string[] = [];
    for (const idea of workspaceIdeas(slug)) {
      if (suggestions.length === 3) break;
      if (!(await workspaceTaken(db, idea))) suggestions.push(idea);
    }
    return { slug, available, suggestions };
  });
}
