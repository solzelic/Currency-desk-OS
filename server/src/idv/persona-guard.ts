/* One key check for every outbound Persona call. It runs before fetch.
   An unknown host fails closed. A key with no persona_ prefix is allowed
   only in tests, or when the base is a stub that is not Persona's host. */
import { isProductionRuntime, isStagingRuntime, requestHost } from "../auth/staging-runtime.js";
import { personaKeyMatchesRuntime } from "./providers/persona.js";

export class PersonaKeyRefused extends Error {
  readonly code: "persona_runtime_unknown" | "persona_key_refused" | "persona_key_unprefixed";
  constructor(code: "persona_runtime_unknown" | "persona_key_refused" | "persona_key_unprefixed") {
    super(code);
    this.name = "PersonaKeyRefused";
    this.code = code;
  }
}

export function personaRuntime(env: NodeJS.ProcessEnv): "staging" | "live" | "local" | "unknown" {
  if (isProductionRuntime(env)) return "live";
  if (isStagingRuntime(undefined, env)) return "staging";
  if (requestHost(env.RENDER_EXTERNAL_HOSTNAME) === "") return "local";
  return "unknown";
}

export function isStubPersonaBase(base: string): boolean {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "withpersona.com" || host.endsWith(".withpersona.com")) return false;
    return true;
  } catch {
    return false;
  }
}

export function assertPersonaKey(key: string, env: NodeJS.ProcessEnv, base: string): void {
  if (personaRuntime(env) === "unknown") throw new PersonaKeyRefused("persona_runtime_unknown");
  if (!personaKeyMatchesRuntime(key, env)) throw new PersonaKeyRefused("persona_key_refused");
  const nodeEnv = "NODE_ENV" in env ? env.NODE_ENV : process.env.NODE_ENV;
  if (!key.trim().startsWith("persona_") && nodeEnv !== "test" && !isStubPersonaBase(base)) {
    throw new PersonaKeyRefused("persona_key_unprefixed");
  }
}

export async function personaFetch(input: {
  key: string;
  env: NodeJS.ProcessEnv;
  base: string;
  path: string;
  init?: RequestInit;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const base = input.base.replace(/\/$/, "");
  assertPersonaKey(input.key, input.env, base);
  const fetchImpl = input.fetchImpl ?? fetch;
  return fetchImpl(`${base}${input.path}`, { ...input.init, redirect: "manual" });
}
