/* ============================================================
   Hosted customer sites — CurrencyDesk serves each customer's
   public storefront.

   Two doors to the same site:
     1. Path:    /sites/<slug>/…   (always available — build, demo, share)
     2. Domain:  the customer's own domain. The owner records it in
        Settings; once they point DNS (CNAME/ALIAS) at the CurrencyDesk
        host, every request whose Host header matches is rewritten to
        /sites/<slug>/… — the handoff needs no code change.

   The slug → directory registry is code for now (one template per
   customer); the domain → slug map lives on the tenant row and is
   cached in memory because Fastify's rewriteUrl hook must be sync.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { isNotNull } from "drizzle-orm";
import { schema } from "./db/index.js";
import type { Db } from "./db/index.js";

// which directory (under STATIC_DIR) holds each customer's site
export const SITES: Record<string, { dir: string; index: string }> = {
  yorkfx: { dir: "YorkFX", index: "YorkFX Homepage.html" },
};

// host (lowercase, no www, no port) → slug. Refreshed from the DB.
const siteDomains = new Map<string, string>();
let siteDomainRefreshes = 0;

/** Safety reload. Neon suspends after 5 minutes with no queries, so this
    stays at half an hour or longer. A shorter setting is raised to the floor. */
export const SITE_DOMAIN_REFRESH_MIN_MS = 30 * 60 * 1000;

/** How many times the map has been loaded from the database. */
export function siteDomainRefreshCount(): number {
  return siteDomainRefreshes;
}

/** `SITE_DOMAIN_REFRESH_MINUTES`. Missing, junk, or below 30 becomes 30 minutes. */
export function siteDomainRefreshIntervalMs(rawMinutes: string | undefined): number {
  const minutes = Number(rawMinutes);
  if (!Number.isFinite(minutes)) return SITE_DOMAIN_REFRESH_MIN_MS;
  return Math.max(30, Math.trunc(minutes)) * 60_000;
}

export async function refreshSiteDomains(db: Db): Promise<void> {
  siteDomainRefreshes += 1;
  const rows = await db
    .select({ slug: schema.tenants.siteSlug, domain: schema.tenants.siteDomain })
    .from(schema.tenants)
    .where(isNotNull(schema.tenants.siteDomain));
  siteDomains.clear();
  for (const r of rows) {
    if (r.slug && r.domain && SITES[r.slug]) siteDomains.set(r.domain.toLowerCase(), r.slug);
  }
}

/** Periodic safety reload. `intervalMs` below the floor is raised to it,
    so a 60 second timer cannot be installed. */
export function startSiteDomainRefresh(db: Db, intervalMs: number): () => void {
  const requested = Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : SITE_DOMAIN_REFRESH_MIN_MS;
  const ms = Math.max(SITE_DOMAIN_REFRESH_MIN_MS, requested);
  const timer = setInterval(() => {
    void refreshSiteDomains(db).catch(() => {});
  }, ms);
  if (typeof (timer as { unref?: unknown }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}

/* which site does this Host header belong to? (custom-domain visitors)
   Memory only. An unknown host must not query the database: the platform
   host is unknown on every page view, and a query a minute would keep
   Neon from suspending. */
export function siteSlugForHost(host: string | undefined): string | null {
  if (!host) return null;
  return siteDomains.get(host.toLowerCase().split(":")[0]!.replace(/^www\./, "")) ?? null;
}

/* sync — used by Fastify's rewriteUrl, which runs before routing */
export function rewriteHostToSite(host: string | undefined, url: string): string {
  if (!host) return url;
  const bare = host.toLowerCase().split(":")[0]!.replace(/^www\./, "");
  const slug = siteDomains.get(bare);
  if (!slug) return url;
  // the customer's domain serves ONLY their site; API calls pass through
  // so the rate-board embed on their pages keeps working
  if (url.startsWith("/api/") || url.startsWith("/sites/")) return url;
  return "/sites/" + slug + url;
}

export async function registerSiteRoutes(app: FastifyInstance, staticDir: string): Promise<void> {
  for (const [slug, site] of Object.entries(SITES)) {
    const root = path.join(staticDir, site.dir);
    if (!existsSync(root)) continue;
    await app.register(fastifyStatic, { root, prefix: `/sites/${slug}/`, decorateReply: false, index: false });
    // trailing slash matters: relative links inside the pages resolve
    // against the directory, so the bare slug redirects into it
    app.get(`/sites/${slug}`, (_req, reply) => reply.redirect(`/sites/${slug}/`, 308));
    app.get(`/sites/${slug}/`, (_req, reply) => reply.sendFile(site.index, root));
  }
  // the site pages load the shared converter via "../yorkfx-converter.js",
  // which resolves to /sites/<file> — serve those repo-root scripts there
  for (const shared of ["yorkfx-converter.js", "yorkfx.css"]) {
    if (existsSync(path.join(staticDir, shared))) {
      app.get(`/sites/${shared}`, (_req, reply) => reply.sendFile(shared, staticDir));
    }
  }
}

/* Is a storefront actually deployed for this slug? A tenant can carry a site
   address long before there is anything to serve at it, and "they have a
   slug" is not the same claim as "a visitor sees a shop". */
export const hasHostedSite = (slug: string | null | undefined): boolean => !!slug && slug in SITES;
