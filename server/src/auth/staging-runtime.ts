/* Staging runtime. One guard for the quick sign-in door, and the
   host-plus-flag half that a follow-up can reuse for sandbox email,
   SMS, and identity checks (isStagingRuntime).

   All three have to be true or the door answers 404:
     1. STAGING is exactly "1". Live never sets it.
     2. The host is staging.currencydeskos.com, or a pull-request
        preview of this service. The host is the Host header
        rewriteHostToSite already reads (app.ts). X-Forwarded-Host
        is not trusted.
     3. The shop is the seeded York FX demo desk.

   currencydeskos.com and www.currencydeskos.com are refused even
   when the flag is set. */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { isDemoDeskTenant } from "../demo-desk.js";
import { DEMO } from "../seed.js";

export const STAGING_HOST = "staging.currencydeskos.com";
const LIVE_HOSTS = new Set(["currencydeskos.com", "www.currencydeskos.com"]);
/* Render names a preview <service>-pr-<number>.onrender.com.
   The service in render.yaml is currencydesk. Anything else on
   onrender.com, including the service's own host, is refused. */
const PREVIEW_HOST = /^currencydesk-pr-[1-9]\d*\.onrender\.com$/;

/** Host header, lower case, port stripped. Same field app.ts passes
    to rewriteHostToSite. Not X-Forwarded-Host. */
export function requestHost(host: string | string[] | undefined): string {
  const raw = Array.isArray(host) ? host[0] : host;
  if (!raw) return "";
  const bare = raw.trim().toLowerCase().split(":")[0] ?? "";
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

export function isStagingHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host || LIVE_HOSTS.has(host)) return false;
  if (host === STAGING_HOST) return true;
  /* A preview is both things: Render sets IS_PULL_REQUEST=true, and
     the host matches this service. Either one alone is not enough. */
  return env.IS_PULL_REQUEST === "true" && PREVIEW_HOST.test(host);
}

/** Flag plus host. No shop check. The follow-up sandbox guard
    imports this and does not grow a second copy of the host rule. */
export function isStagingRuntime(
  host: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.STAGING === "1" && isStagingHost(requestHost(host), env);
}

/** Flag, host, and the seeded demo shop. Quick sign-in uses only this. */
export async function stagingQuickSignInGuard(
  db: Db,
  host: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isStagingRuntime(host, env)) return false;
  const row = await db
    .select({ id: schema.tenants.id, siteSlug: schema.tenants.siteSlug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, DEMO.tenantId))
    .limit(1)
    .then((rows) => rows[0]);
  return !!row && isDemoDeskTenant(row);
}
