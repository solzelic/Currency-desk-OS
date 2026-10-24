/* Field rules for the persona provider. apiKeyRef is an environment
   variable name. The value is read here, from that name, and nowhere else. */
import type { IdvSettingsProvider } from "../provider.js";

const TEMPLATE = /^(itmpl|itmplv|tmpl)_[A-Za-z0-9_-]{1,80}$/;
const SHARED = "PERSONA_API_KEY";
const NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
const SECRET_PREFIX = /^(?:sk_|key_)/i;

export function personaKeyAllowed(name: string, shopCode: string): boolean {
  if (!NAME.test(name)) return false;
  if (name === SHARED) return true;
  return shopCode !== "" && name === `${SHARED}_${shopCode}`;
}

function looksLikeKey(name: string): boolean {
  if (SECRET_PREFIX.test(name)) return true;
  if (/^persona_/i.test(name) && name !== SHARED && !name.startsWith(`${SHARED}_`)) return true;
  if (name.length < 24 || /^[A-Z][A-Z0-9_]{2,63}$/.test(name)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(name)).length;
  return classes >= 2;
}

/* "key" means the body looks like a secret. "name" means it is not this shop's name. */
export function personaRefIssue(name: string, shopCode: string): "key" | "name" | null {
  if (personaKeyAllowed(name, shopCode)) return null;
  return looksLikeKey(name) ? "key" : "name";
}

export function personaConnection(
  input: { apiKeyRef?: string | null; templateId?: string | null; shopCode?: string },
  env: NodeJS.ProcessEnv,
): { apiKey: string; templateId: string } | null {
  const requested = (input.apiKeyRef ?? "").trim();
  const name = requested === "" ? SHARED : requested;
  const templateId = (input.templateId ?? "").trim();
  if (!personaKeyAllowed(name, input.shopCode ?? "") || templateId === "") return null;
  const apiKey = (env[name] ?? "").trim();
  return apiKey === "" ? null : { apiKey, templateId };
}

export const personaProvider: IdvSettingsProvider = {
  id: "persona",
  fieldIssue(input) {
    if (input.apiKeyRef && !personaKeyAllowed(input.apiKeyRef, input.shopCode ?? "")) return "reference";
    if (input.templateId && !TEMPLATE.test(input.templateId)) return "template";
    return null;
  },
};
