/* Persona client and webhook signature check.
   Both secrets are required. A missing one leaves the desk disconnected.
   The raw webhook body and the HTTP response body are identity data.
   They are never logged and never attached to an error. */
import { createHmac, timingSafeEqual } from "node:crypto";

export const PERSONA_DISCONNECTED = "ID checks not connected yet";

const API_HOST = "https://api.withpersona.com";
const MAX_SKEW_MS = 5 * 60 * 1000;

const EVENT_NAMES = new Set([
  "inquiry.created",
  "inquiry.started",
  "inquiry.completed",
  "inquiry.approved",
  "inquiry.declined",
  "inquiry.marked-for-review",
  "inquiry.failed",
  "inquiry.expired",
]);

const STATUSES = new Set([
  "created",
  "pending",
  "completed",
  "approved",
  "declined",
  "needs_review",
  "failed",
  "expired",
]);

const CLIENT_ID = /^cli_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^evt_[A-Za-z0-9_-]{1,80}$/;
const INQUIRY_ID = /^inq_[A-Za-z0-9_-]{1,80}$/;

export type PersonaEnvironment = "sandbox" | "live" | "unknown";

export interface PersonaConfig {
  apiKey: string;
  webhookSecret: string;
  environment: PersonaEnvironment;
  apiBase: string;
}

export interface PersonaEventRecord {
  eventId: string;
  eventName: string;
  inquiryId: string;
  status: string;
  clientId: string | null;
}

export class PersonaRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Persona did not accept the inquiry (${status}).`);
    this.name = "PersonaRequestError";
    this.status = status;
  }
}

export function personaEnvironment(apiKey: string): PersonaEnvironment {
  if (apiKey.startsWith("persona_sandbox_")) return "sandbox";
  if (apiKey.startsWith("persona_production_")) return "live";
  return "unknown";
}

export function personaConfig(env: NodeJS.ProcessEnv = process.env): PersonaConfig | null {
  const apiKey = env.PERSONA_API_KEY?.trim() ?? "";
  const webhookSecret = env.PERSONA_WEBHOOK_SECRET?.trim() ?? "";
  if (!apiKey || !webhookSecret) return null;
  const configured = env.PERSONA_API_BASE?.trim().replace(/\/$/, "") ?? "";
  return {
    apiKey,
    webhookSecret,
    environment: personaEnvironment(apiKey),
    apiBase: configured || API_HOST,
  };
}

export function isClientId(value: string): boolean {
  return CLIENT_ID.test(value);
}

/* Persona-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]
   HMAC-SHA256 of `${t}.${rawBody}` with the webhook secret.
   A timestamp more than five minutes off is rejected. */
export function verifyPersonaSignature(input: {
  rawBody: Buffer;
  signature: string;
  secret: string;
  now?: number;
}): boolean {
  const parts = input.signature.split(",").map((part) => part.trim()).filter(Boolean);
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const at = Number(timestamp) * 1000;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(at) || Math.abs(now - at) > MAX_SKEW_MS) return false;
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${input.rawBody.toString("utf8")}`).digest();
  return signatures.some((supplied) => {
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const actual = Buffer.from(supplied, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export async function createPersonaInquiry(input: {
  config: PersonaConfig;
  templateId: string;
  referenceId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ inquiryId: string }> {
  if (!input.templateId.trim() || !isClientId(input.referenceId)) throw new PersonaRequestError(400);
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.config.apiBase}/api/v1/inquiries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.config.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "key-inflection": "kebab",
      },
      body: JSON.stringify({
        data: {
          attributes: {
            "inquiry-template-id": input.templateId,
            "reference-id": input.referenceId,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    if (name === "TimeoutError" || name === "AbortError") throw new PersonaRequestError(504);
    throw new PersonaRequestError(502);
  }
  if (!response.ok) {
    await discardBody(response);
    throw new PersonaRequestError(response.status);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error(`[persona] inquiry response was not json (${name})`);
    throw new PersonaRequestError(502);
  }
  const inquiryId = inquiryIdOf(parsed);
  if (!inquiryId) throw new PersonaRequestError(502);
  return { inquiryId };
}

/* null: the body is not an event we can name.
   "ignore": it is an event, and not one this desk stores. */
export function parsePersonaEvent(body: unknown): PersonaEventRecord | "ignore" | null {
  const data = objectOf(body).data;
  const root = objectOf(data);
  const attributes = objectOf(root.attributes);
  const eventId = stringOf(root.id);
  const eventName = stringOf(attributes.name);
  if (!eventId || !EVENT_ID.test(eventId) || !eventName) return null;
  if (!EVENT_NAMES.has(eventName)) return "ignore";
  const inquiry = objectOf(objectOf(attributes.payload).data);
  const inquiryId = stringOf(inquiry.id);
  if (!inquiryId || !INQUIRY_ID.test(inquiryId)) return null;
  const inquiryAttributes = objectOf(inquiry.attributes);
  const rawStatus = stringOf(inquiryAttributes.status);
  const reference = stringOf(inquiryAttributes["reference-id"]);
  return {
    eventId,
    eventName,
    inquiryId,
    status: rawStatus && STATUSES.has(rawStatus) ? rawStatus : "unknown",
    clientId: reference && isClientId(reference) ? reference : null,
  };
}

async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.error(`[persona] response discard failed (${name})`);
  }
}

function inquiryIdOf(body: unknown): string | null {
  const id = stringOf(objectOf(objectOf(body).data).id);
  return id && INQUIRY_ID.test(id) ? id : null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
