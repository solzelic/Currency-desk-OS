/* A staging test shop may confirm with 0000 while a person has no PIN.
   Closed unless every check passes: STAGING_DEFAULT_PIN is exactly "1",
   isStagingRuntime agrees for this request's Host (STAGING, the
   service's RENDER_EXTERNAL_HOSTNAME, and the Host are all staging), and
   the signed-in session's own shop, read from the database, is a test
   shop. A live host or a real shop is refused even with the flag set.
   0000 lives here only; it is never hashed or stored. */
import { isStagingRuntime } from "./staging-runtime.js";

export const STAGING_DEFAULT_PIN = "0000";

export type TestShopFlag = { readonly isTestShop?: unknown } | null | undefined;

export function stagingDefaultPinAllowed(host: string, env: NodeJS.ProcessEnv, tenant: TestShopFlag): boolean {
  try {
    if (env.STAGING_DEFAULT_PIN !== "1") return false;
    if (!isStagingRuntime(typeof host === "string" ? host : "", env)) return false;
    return !!tenant && tenant.isTestShop === true;
  } catch {
    return false;   // anything unreadable keeps the gate shut
  }
}
