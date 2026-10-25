/* Flag plus host. Nothing in this file registers a route.
   A follow-up imports isStagingRuntime for sandbox email, SMS,
   and identity checks. Live does not set STAGING.

   The host is the Host header rewriteHostToSite already reads.
   X-Forwarded-Host is not trusted. currencydeskos.com and
   www.currencydeskos.com are refused even when the flag is set. */
export const STAGING_HOST = "staging.currencydeskos.com";
const LIVE_HOSTS = new Set(["currencydeskos.com", "www.currencydeskos.com"]);
/* The staging service is currencydesk-staging, so a preview is
   currencydesk-staging-pr-<number>.onrender.com. currencydesk-pr-*
   is a different service. A suffix or a prefix lookalike is refused. */
const PREVIEW_HOST = /^currencydesk-staging-pr-[0-9]+\.onrender\.com$/;

/** Host header, lower case, port stripped, one trailing dot removed.
    An array host uses the first value only. */
export function requestHost(host: string | string[] | undefined): string {
  const raw = Array.isArray(host) ? host[0] : host;
  if (!raw) return "";
  const bare = raw.trim().toLowerCase().split(":")[0] ?? "";
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

export function isStagingHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host || LIVE_HOSTS.has(host)) return false;
  if (host === STAGING_HOST) return true;
  /* A preview needs both: Render sets IS_PULL_REQUEST=true, and the
     host is this service. Either one alone is not enough. */
  return env.IS_PULL_REQUEST === "true" && PREVIEW_HOST.test(host);
}

/** STAGING=1 and a staging host. No shop check. */
export function isStagingRuntime(
  host: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.STAGING === "1" && isStagingHost(requestHost(host), env);
}
