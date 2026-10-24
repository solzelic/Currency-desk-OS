/* Webhook providers and start providers. The route asks this map.
   Provider names and env vars stay in the adapter. */
import type { IdvProvider } from "./provider.js";
import { personaConnection } from "./providers/persona.js";
import { createPersonaProvider, startPersonaCheck } from "./providers/persona/index.js";

const PERSONA = "persona";

export type IdvRouteOptions = {
  persona?: IdvProvider | null;
  providers?: Readonly<Record<string, IdvProvider | null>>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cap?: number;
};

export function webhookProviders(options?: IdvRouteOptions): Record<string, IdvProvider | null> {
  if (options && "persona" in options) return { [PERSONA]: options.persona ?? null };
  return { [PERSONA]: createPersonaProvider(options?.env) };
}

/* null: the caller passed no provider. Absent: unknown provider.
   The adapter decides whether this shop's key name and template connect. */
export function startProviders(options?: IdvRouteOptions): Record<string, IdvProvider | null> {
  if (options?.providers) return { ...options.providers };
  const env = options?.env ?? process.env;
  const deps = { env, fetch: options?.fetch, sleep: options?.sleep };
  return {
    [PERSONA]: {
      name: PERSONA,
      ready(input) { return personaConnection(input, env) !== null; },
      startCheck(input) { return startPersonaCheck(input, deps); },
      verifyWebhook() { return false; },
      parseResult() { return null; },
    },
  };
}
