/* The hostname Render assigned this process is the gate.
   A request Host can only agree with it. It is never enough
   on its own. Nothing here registers a route. A follow-up
   imports isStagingRuntime for sandbox email, SMS, and
   identity checks. Live does not set STAGING. */
export const STAGING_HOST = "staging.currencydeskos.com";
const SERVICE_HOST = "currencydesk-staging.onrender.com";
const LIVE_HOSTS = new Set(["currencydeskos.com", "www.currencydeskos.com"]);
/* The staging service is currencydesk-staging, so a preview is
   currencydesk-staging-pr-<digits>.onrender.com. The number is
   digits only. currencydesk-pr-* is a different service. */
const PREVIEW_HOST = /^currencydesk-staging-pr-[0-9]+\.onrender\.com$/;

/** Host header, lower case, port stripped, one trailing dot removed.
    An array host uses the first value only. */
export function requestHost(host: string | string[] | undefined): string {
  const raw = Array.isArray(host) ? host[0] : host;
  if (!raw) return "";
  const bare = raw.trim().toLowerCase().split(":")[0] ?? "";
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

/** The custom staging host, the staging service host, or a
    digits-only preview while IS_PULL_REQUEST is exactly true.
    Live hosts are refused. */
export function isStagingHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!host || LIVE_HOSTS.has(host)) return false;
  if (host === STAGING_HOST || host === SERVICE_HOST) return true;
  return env.IS_PULL_REQUEST === "true" && PREVIEW_HOST.test(host);
}

/** STAGING is exactly "1", and RENDER_EXTERNAL_HOSTNAME is a
    staging host. A request Host, when passed, must be one too. */
export function isStagingRuntime(
  host: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.STAGING !== "1") return false;
  if (!isStagingHost(requestHost(env.RENDER_EXTERNAL_HOSTNAME), env)) return false;
  if (host === undefined) return true;
  return isStagingHost(requestHost(host), env);
}

/* The one door later staging routes reuse. x-forwarded-host is
   never a host: naming the staging host there does not open a
   live Host, and naming a live host there does not close a
   real staging Host. */
export type StagingDoorHeaders = {
  host?: string | string[] | undefined;
  "x-forwarded-host"?: string | string[] | undefined;
};

/** No headers: the registration gate, STAGING exactly "1".
    With headers: that flag, plus isStagingRuntime on the Host
    header. A missing Host is closed. */
export function stagingDoorOpen(
  headers?: StagingDoorHeaders,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (headers === undefined) return env.STAGING === "1";
  return isStagingRuntime(headers.host ?? "", env);
}
