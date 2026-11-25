/* Webhook providers and start providers. The route asks this map.
   Provider names and env vars stay in the adapter. */
import type { ClientLookup, IdvProvider } from "./provider.js";
import { createDiditProvider } from "./providers/didit.js";
import { personaConnection } from "./providers/persona.js";
import { createPersonaProvider, startPersonaCheck } from "./providers/persona/index.js";

const PERSONA = "persona";
const DIDIT = "didit";

export type IdvRouteOptions = {
  persona?: IdvProvider | null;
  didit?: IdvProvider | null;
  providers?: Readonly<Record<string, IdvProvider | null>>;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  cap?: number;
  clients?: ClientLookup;
  ratePerMinute?: number;
  rateLimitStore?: Map<string, number[]>;
  mail?: (to: string, subject: string, text: string) => Promise<"sent" | "failed">;
  now?: () => number;
};

function diditWebhook(options?: IdvRouteOptions): IdvProvider | null {
  if (options && "didit" in options) return options.didit ?? null;
  if (options && "persona" in options && options.env === undefined) return null;
  return createDiditProvider(options?.env);
}

export function webhookProviders(options?: IdvRouteOptions): Record<string, IdvProvider | null> {
  const didit = diditWebhook(options);
  if (options && "persona" in options) return { [PERSONA]: options.persona ?? null, [DIDIT]: didit };
  return { [PERSONA]: createPersonaProvider(options?.env), [DIDIT]: didit };
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
    [DIDIT]: createDiditProvider(env, deps),
  };
}
