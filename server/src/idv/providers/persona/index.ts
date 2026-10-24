/* Persona adapter. Header t=<unix>,v1=<hex>. HMAC-SHA256 over the raw
   body bytes, constant-time compare, five-minute window. Rotation sends
   two sets separated by a space. Either configured secret may pass. */
import * as crypto from "node:crypto";
import type { IdvOutcome, IdvProvider, IdvResult, IdvWebhookInput } from "../../provider.js";

const WINDOW_MS = 5 * 60 * 1000;
const OUTCOME: Record<string, IdvOutcome> = {
  created: "pending", pending: "pending", started: "pending", completed: "pending",
  approved: "approved", declined: "declined", "needs-review": "review", needs_review: "review",
  failed: "failed", expired: "expired",
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
  const status = typeof fields.status === "string" ? fields.status : "";
  return { eventId, provider: "persona", providerRef, referenceId, outcome: OUTCOME[status] ?? "unknown" };
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
    startCheck() { return Promise.reject(new Error("not_in_this_step")); },
    verifyWebhook(input) { return verify(input, secrets); },
    parseResult: parse,
  };
}
