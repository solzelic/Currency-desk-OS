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

/** Safety reload. Neon suspends after 5 minutes with no queries.
    The gap stays between 30 minutes and 24 hours. setInterval stores the
    delay in a 32-bit signed integer, so a larger value fires in 1 ms. */
export const SITE_DOMAIN_REFRESH_MIN_MS = 30 * 60 * 1000;
export const SITE_DOMAIN_REFRESH_MAX_MS = 24 * 60 * 60 * 1000;
const SITE_DOMAIN_REFRESH_MIN_MINUTES = 30;
const SITE_DOMAIN_REFRESH_MAX_MINUTES = 24 * 60;

/** How many times the map has been loaded from the database. */
export function siteDomainRefreshCount(): number {
  return siteDomainRefreshes;
}

/** `SITE_DOMAIN_REFRESH_MINUTES`. Missing or junk becomes 30 minutes.
    Below 30 becomes 30. Above 1440, or Infinity, becomes 24 hours. */
export function siteDomainRefreshIntervalMs(rawMinutes: string | undefined): number {
  const minutes = Number(rawMinutes);
  if (minutes === Number.POSITIVE_INFINITY) return SITE_DOMAIN_REFRESH_MAX_MS;
  if (!Number.isFinite(minutes)) return SITE_DOMAIN_REFRESH_MIN_MS;
  const clamped = Math.min(SITE_DOMAIN_REFRESH_MAX_MINUTES, Math.max(SITE_DOMAIN_REFRESH_MIN_MINUTES, Math.trunc(minutes)));
  return clamped * 60_000;
}

export function warnSiteDomainRefreshFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown error";
  console.warn(`[site-domains] refresh failed: ${message}`);
}

function clampSiteDomainRefreshMs(intervalMs: number): number {
  if (intervalMs === Number.POSITIVE_INFINITY) return SITE_DOMAIN_REFRESH_MAX_MS;
  if (!Number.isFinite(intervalMs)) return SITE_DOMAIN_REFRESH_MIN_MS;
  const ms = Math.trunc(intervalMs);
  if (ms > SITE_DOMAIN_REFRESH_MAX_MS) return SITE_DOMAIN_REFRESH_MAX_MS;
  if (ms < SITE_DOMAIN_REFRESH_MIN_MS) return SITE_DOMAIN_REFRESH_MIN_MS;
  return ms;
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

/** Periodic safety reload. Values outside 30 minutes to 24 hours are clamped,
    so a 60 second timer cannot be installed and a huge delay cannot overflow. */
export function startSiteDomainRefresh(db: Db, intervalMs: number): () => void {
  const ms = clampSiteDomainRefreshMs(intervalMs);
  const timer = setInterval(() => {
    void refreshSiteDomains(db).catch(warnSiteDomainRefreshFailure);
  }, ms);
  if (typeof (timer as { unref?: unknown }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}

/* Host without port, one trailing dot, or a leading www. A DNS name is
   sometimes sent with the root dot still on it. */
function bareSiteHost(host: string): string {
  const withoutPort = host.toLowerCase().split(":")[0]!;
  const withoutDot = withoutPort.endsWith(".") ? withoutPort.slice(0, -1) : withoutPort;
  return withoutDot.replace(/^www\./, "");
}

/* which site does this Host header belong to? (custom-domain visitors)
   Memory only. An unknown host must not query the database: the platform
   host is unknown on every page view, and a query a minute would keep
   Neon from suspending. */
export function siteSlugForHost(host: string | undefined): string | null {
  if (!host) return null;
  return siteDomains.get(bareSiteHost(host)) ?? null;
}

/* sync — used by Fastify's rewriteUrl, which runs before routing */
export function rewriteHostToSite(host: string | undefined, url: string): string {
  if (!host) return url;
  const slug = siteDomains.get(bareSiteHost(host));
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
