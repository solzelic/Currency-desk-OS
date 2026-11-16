/* Test seeds and mail must remain confined to an explicitly local runtime,
   even if a test flag accidentally reaches a deployment's environment. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Use the same parser as pg: URL query host overrides must also be checked.
const parseConnectionString = require("pg-connection-string") as (value: string) => { host?: string | null };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const localHost = (host: string) => LOOPBACK.has(host.trim().replace(/^\[|\]$/g, ""));
export function localTestRuntime(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV !== "test" && env.NODE_ENV !== "development") return false;
  if ((env.STAGING && env.STAGING !== "0") || env.RENDER || env.RENDER_SERVICE_ID || env.RENDER_EXTERNAL_HOSTNAME) return false;
  if (!localHost(env.HOST || "127.0.0.1")) return false;
  for (const value of [env.DATABASE_URL, env.TEST_DATABASE_URL, env.SEAM_DATABASE_URL]) {
    if (!value) continue;
    try { if (!localHost(parseConnectionString(value).host || env.PGHOST || "localhost")) return false; }
    catch { return false; } // malformed configuration must never enable test access
  }
  return !env.PGHOST || localHost(env.PGHOST);
}
export function localTestRequest(ip: string, host: string | undefined): boolean {
  if (!localHost(ip.replace(/^::ffff:/, "")) || !host) return false;
  try { return localHost(new URL('http://' + host).hostname); } catch { return false; }
}
