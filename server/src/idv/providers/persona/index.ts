/* Persona adapter. Header t=<unix>,v1=<hex>. HMAC-SHA256 over the raw
   body bytes, constant-time compare, five-minute window. Rotation sends
   two sets separated by a space. Either configured secret may pass. */
import * as crypto from "node:crypto";
import type { IdvOutcome, IdvProvider, IdvResult, IdvStart, IdvWebhookInput } from "../../provider.js";

const WINDOW_MS = 5 * 60 * 1000;
const ATTEMPTS = 3;
/* Persona uses one host. A sandbox key selects the sandbox environment. */
export const PERSONA_API_BASE_DEFAULT = "https://api.withpersona.com/api/v1";
const OUTCOME: Record<string, IdvOutcome> = {
  created: "pending", pending: "pending", started: "pending", completed: "pending",
  approved: "approved", declined: "declined", "needs-review": "review", needs_review: "review",
  failed: "failed", expired: "expired",
};
const EVENTS: Record<string, Pick<IdvResult, "outcome" | "inquiryStatus">> = {
  "inquiry.created": { outcome: "pending", inquiryStatus: "in progress" }, "inquiry.started": { outcome: "pending", inquiryStatus: "in progress" },
  "inquiry.completed": { outcome: "pending" }, "inquiry.approved": { outcome: "approved" }, "inquiry.declined": { outcome: "declined" },
  "inquiry.marked-for-review": { outcome: "review", inquiryStatus: "needs review" }, "inquiry.failed": { outcome: "failed" }, "inquiry.expired": { outcome: "expired" },
};

function header(value: string | string[] | undefined): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

function setOk(set: string, raw: Buffer, secrets: readonly string[], now: number): boolean {
  const parts = set.split(",").map((part) => part.trim()).filter(Boolean);
  const stamps = parts.filter((part) => part.startsWith("t=")).map((part) => part.slice(2));
  const macs = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  const timestamp = stamps[0];
  if (stamps.length !== 1 || !timestamp || macs.length === 0 || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > WINDOW_MS) return false;
  return secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(`${timestamp}.`), raw])).digest();
    return macs.some((supplied) => {
      if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
      const actual = Buffer.from(supplied, "hex");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
  });
}

function verify(input: IdvWebhookInput, secrets: readonly string[]): boolean {
  const sets = header(input.headers["persona-signature"]).trim().split(/\s+/).filter(Boolean);
  if (secrets.length === 0 || sets.length === 0 || sets.length > 4) return false;
  const now = input.now ?? Date.now();
  return sets.some((set) => setOk(set, input.rawBody, secrets, now));
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parse(body: unknown): IdvResult | null {
  const data = obj(obj(body).data);
  const inquiry = obj(obj(obj(obj(data.attributes).payload).data));
  const fields = obj(inquiry.attributes);
  const eventId = typeof data.id === "string" ? data.id : "";
  const providerRef = typeof inquiry.id === "string" ? inquiry.id : "";
  const referenceId = typeof fields["reference-id"] === "string" ? fields["reference-id"] : "";
  if (!eventId || !providerRef || !referenceId) return null;
  const attributes = obj(data.attributes);
  const status = typeof fields.status === "string" ? fields.status : "";
  const named = typeof attributes.name === "string" ? EVENTS[attributes.name] : undefined;
  const outcome = named?.outcome ?? OUTCOME[status] ?? "unknown";
  return { eventId, provider: "persona", providerRef, referenceId, outcome, ...(named?.inquiryStatus ? { inquiryStatus: named.inquiryStatus } : {}) };
}

export async function startPersonaCheck(
  input: IdvStart,
  deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ providerRef: string }> {
  const env = deps.env ?? process.env;
  const key = env.PERSONA_API_KEY?.trim() ?? "";
  const template = env.PERSONA_TEMPLATE_ID?.trim() ?? "";
  if (!key || !template) throw new Error("not_connected");
  const base = (env.PERSONA_API_BASE?.trim() || PERSONA_API_BASE_DEFAULT).replace(/\/$/, "");
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify({ data: { attributes: { "inquiry-template-id": template, "reference-id": input.referenceId } } });
  let status = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const res = await fetchImpl(`${base}/inquiries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": input.referenceId,
        "persona-version": "2023-01-05",
      },
      body,
    });
    status = res.status;
    if (status === 200 || status === 201) {
      const payload = await res.json() as { data?: { id?: unknown } };
      const providerRef = typeof payload.data?.id === "string" ? payload.data.id : "";
      if (!providerRef) throw new Error("provider_ref_missing");
      return { providerRef };
    }
    await res.body?.cancel();
    if ((status !== 429 && status < 500) || attempt === ATTEMPTS) break;
    await sleep(25 * 2 ** (attempt - 1));
  }
  throw new Error(status === 429 || status >= 500 ? "provider_unavailable" : "provider_rejected");
}

/* The only place these variables are read. Callers pass a fixture or nothing. */
export function createPersonaProvider(env?: NodeJS.ProcessEnv): IdvProvider | null {
  const source = env ?? process.env;
  const secrets = ["PERSONA_WEBHOOK_SECRET", "PERSONA_WEBHOOK_SECRET_PREVIOUS"]
    .map((name) => source[name]?.trim() ?? "")
    .filter(Boolean);
  if (secrets.length === 0) return null;
  return {
    name: "persona",
    startCheck(input) { return startPersonaCheck(input); },
    verifyWebhook(input) { return verify(input, secrets); },
    parseResult: parse,
  };
}
