/* Only seam-server.ts imports this transport fixture. Production continues
   using the real HIBP range request, parser, timeout and fail-closed verdict. */
import { createHash } from "node:crypto";
import { localTestRuntime } from "./local-test-runtime.js";

export const SEAM_BREACHED_PASSWORD = "seam leaked lantern phrase";
export const SEAM_UNAVAILABLE_PASSWORD = "seam unavailable lantern phrase";
const hash = (value: string) => createHash("sha1").update(value).digest("hex").toUpperCase();
const breached = hash(SEAM_BREACHED_PASSWORD);
const unavailablePrefix = hash(SEAM_UNAVAILABLE_PASSWORD).slice(0, 5);
const padding = "00000000000000000000000000000000000:0";

/** Substitute only a local seam's exact HIBP GET; leave every other fetch alone. */
export function seamBreachFetch(upstream: typeof fetch, env: NodeJS.ProcessEnv = process.env): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const range = /^\/range\/([0-9A-F]{5})$/.exec(url.pathname);
    // The dedicated local staging suite deliberately sets these two hostname
    // markers. Opt-in may clear only those markers; production/Render, bind
    // address and every database-locality check still have to pass.
    const localRuntime = localTestRuntime(env) || (env.CD_TEST_BREACH_RANGE === "local-staging"
      && env.STAGING === "1" && env.RENDER_EXTERNAL_HOSTNAME === "staging.currencydeskos.com"
      && localTestRuntime({ ...env, STAGING: "0", RENDER_EXTERNAL_HOSTNAME: "" }));
    if (!localRuntime || method !== "GET" || url.origin !== "https://api.pwnedpasswords.com"
      || url.search || url.hash || url.username || url.password || !range) return upstream(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    if (range[1] === unavailablePrefix) return new Response("", { status: 503 });
    const body = range[1] === breached.slice(0, 5) ? `${breached.slice(5)}:12\r\n${padding}` : padding;
    return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
  };
}
