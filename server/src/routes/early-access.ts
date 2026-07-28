/* ============================================================
   How many of the founding cohort are gone.

     GET /api/site/early-access → { claimed, cap, remaining, full }

   The number on the marketing site used to be the literal 64 the design
   was drawn with, so it said the same thing forever. It is counted here
   now, and it moves when somebody applies.

   A spot is claimed by:
     · an early-access application that has not been declined — applying
       reserves a place, which is what the page promises, and
     · a desk that exists without ever having applied — someone invited
       straight in still occupies one of the hundred.

   Declined applications give their place back; counting them would let
   anyone push the number up by applying with addresses we turn down.
   Counting desks and applications separately would double-count the
   ones that became each other, so a desk is only added when no
   application points at it.

   Public and unauthenticated, so it says nothing about WHO — only how
   many — and it is cached briefly: this sits on the front page, and the
   count changing a few seconds late costs nothing.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";

// the size of the founding cohort — a business decision, so it is settable
// without a deploy, and never below what has already been claimed
const DEFAULT_CAP = 100;
const cap = (): number => {
  const raw = Number(process.env.EARLY_ACCESS_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_CAP;
};

const PLATFORM_TENANT = "tnt-platform";
const CACHE_MS = 15_000;
let cached: { at: number; claimed: number } | null = null;

export async function claimedCount(db: Db): Promise<number> {
  const applications = (await db.select().from(schema.enquiries)).filter(
    // never the walkthrough: practising must not tell the site a place has gone
    (e) => e.kind === "early_access" && e.status !== "declined" && !e.isDemo,
  );
  const spokenFor = new Set(applications.map((a) => a.tenantId).filter(Boolean) as string[]);
  const desks = (await db.select().from(schema.tenants)).filter(
    (t) => t.id !== PLATFORM_TENANT && !spokenFor.has(t.id),
  );
  return applications.length + desks.length;
}

export function registerEarlyAccessRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/site/early-access", async (_req, reply) => {
    const now = Date.now();
    if (!cached || now - cached.at > CACHE_MS) {
      cached = { at: now, claimed: await claimedCount(db) };
    }
    const total = cap();
    // the counter is a queue position, not a promise we can break: it never
    // reads past the cohort, however many apply
    const claimed = Math.min(cached.claimed, total);
    reply.header("cache-control", "public, max-age=15");
    return { claimed, cap: total, remaining: Math.max(0, total - claimed), full: claimed >= total };
  });
}

// a signup or application just changed the count — don't serve the old one
export const forgetClaimedCount = (): void => { cached = null; };
