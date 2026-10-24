/* Webhook providers and start providers. The route asks this map.
   Provider names and env vars stay in the adapter. */
import type { IdvProvider } from "./provider.js";
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

/* null: known, but the key or template is unset. Absent: unknown provider. */
export function startProviders(options?: IdvRouteOptions): Record<string, IdvProvider | null> {
  if (options?.providers) return { ...options.providers };
  const env = options?.env ?? process.env;
  if (!env.PERSONA_API_KEY?.trim() || !env.PERSONA_TEMPLATE_ID?.trim()) return { [PERSONA]: null };
  return {
    [PERSONA]: {
      name: PERSONA,
      startCheck(input) { return startPersonaCheck(input, { env, fetch: options?.fetch, sleep: options?.sleep }); },
      verifyWebhook() { return false; },
      parseResult() { return null; },
    },
  };
}
