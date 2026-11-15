/* One-time webhook registration. The signing secret is written to the
   injected stdout once. It is not logged, stored, or sent onward.
   Lists existing webhooks first and does not create a second one for
   the same URL. https://docs.withpersona.com/api-reference/webhooks/create-a-webhook */
import { isStagingRuntime } from "../auth/staging-runtime.js";
import { personaSharedKey } from "./providers/persona.js";
import { PERSONA_API_BASE_DEFAULT, PERSONA_VERSION, PERSONA_WEBHOOK_EVENTS } from "./providers/persona/index.js";

export const STAGING_WEBHOOK_URL = "https://currencydesk-staging.onrender.com/api/webhooks/idv/persona";
const PERMISSION = "This API key needs webhook permission.";

export type WebhookIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof fetch;
};

type Args = { command: string; production: boolean; url: string };

export function readWebhookArgs(argv: readonly string[]): Args | null {
  const command = argv[0] ?? "";
  let production = false;
  let url = STAGING_WEBHOOK_URL;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--production") production = true;
    else if (arg === "--url") {
      url = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--url=")) url = arg.slice("--url=".length);
    else return null;
  }
  return { command, production, url };
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function signingSecret(payload: unknown): string {
  const attributes = obj(obj(obj(payload).data).attributes);
  const listed = Array.isArray(attributes.secrets) ? attributes.secrets : [];
  for (const item of listed) {
    const value = obj(item).value;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const legacy = attributes.secret;
  return typeof legacy === "string" ? legacy.trim() : "";
}

function headers(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    accept: "application/json",
    "key-inflection": "kebab",
    "persona-version": PERSONA_VERSION,
  };
}

async function listUrls(fetchImpl: typeof fetch, base: string, key: string): Promise<string[] | "permission" | "refused"> {
  const urls: string[] = [];
  let next: string | null = `${base}/webhooks`;
  for (let page = 0; page < 10 && next; page += 1) {
    if (!next.startsWith(`${base}/`)) return "refused";
    const res = await fetchImpl(next, { method: "GET", headers: headers(key), redirect: "manual" });
    if (res.status === 403) return "permission";
    if (res.status !== 200) return "refused";
    let parsed: unknown;
    try { parsed = await res.json(); } catch { return "refused"; }
    const payload = obj(parsed);
    const data = Array.isArray(payload.data) ? payload.data : [];
    for (const item of data) {
      const url = obj(obj(item).attributes).url;
      if (typeof url === "string") urls.push(url.trim());
    }
    const link = obj(payload.links).next;
    next = typeof link === "string" && link.trim() ? link.trim() : null;
  }
  return urls;
}

export async function registerPersonaWebhook(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: WebhookIo,
): Promise<number> {
  const args = readWebhookArgs(argv);
  if (!args || args.command !== "register-webhook") {
    io.stderr("Usage: npm run persona -- register-webhook [--url https://...] [--production]");
    return 2;
  }
  if (!args.production && !isStagingRuntime(undefined, env)) {
    io.stderr("register-webhook refused: this is not a staging runtime. Pass --production to run it on another host.");
    return 1;
  }
  const url = args.url.trim();
  if (!url.startsWith("https://") || url.includes(" ")) {
    io.stderr("The webhook URL has to be an https address.");
    return 1;
  }
  const key = personaSharedKey(env);
  if (!key) {
    io.stderr("The Persona API key is not set.");
    return 1;
  }
  const fetchImpl = io.fetch ?? fetch;
  const base = (env.PERSONA_API_BASE?.trim() || PERSONA_API_BASE_DEFAULT).replace(/\/$/, "");
  const existing = await listUrls(fetchImpl, base, key);
  if (existing === "permission") {
    io.stderr(PERMISSION);
    return 1;
  }
  if (existing === "refused") {
    io.stderr("Persona refused the webhook list.");
    return 1;
  }
  if (existing.includes(url)) {
    io.stdout("A webhook for this URL is already registered. Nothing was created.");
    return 0;
  }
  const res = await fetchImpl(`${base}/webhooks`, {
    method: "POST",
    redirect: "manual",
    headers: { ...headers(key), "content-type": "application/json" },
    body: JSON.stringify({
      data: {
        attributes: {
          name: "CurrencyDesk identity checks",
          url,
          "enabled-events": PERSONA_WEBHOOK_EVENTS,
          "api-version": PERSONA_VERSION,
          "api-key-inflection": "kebab",
        },
      },
    }),
  });
  if (res.status === 403) {
    io.stderr(PERMISSION);
    return 1;
  }
  if (res.status !== 200 && res.status !== 201) {
    await res.body?.cancel();
    io.stderr(`Persona refused the webhook registration (${res.status}).`);
    return 1;
  }
  let created: unknown;
  try { created = await res.json(); } catch { created = null; }
  const secret = signingSecret(created);
  if (!secret) {
    io.stderr("Persona did not return a signing secret. Nothing was saved.");
    return 1;
  }
  io.stdout(secret);
  io.stdout("Paste this into PERSONA_WEBHOOK_SECRET in Render. It is shown here once and is not stored.");
  return 0;
}
