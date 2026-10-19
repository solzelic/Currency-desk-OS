/* ============================================================
   Persona: configuration, the webhook signature check, the event
   reader, and the inquiry request.

   OFF UNTIL BOTH SECRETS ARE SET. With PERSONA_API_KEY or
   PERSONA_WEBHOOK_SECRET missing, personaConfig() is null, the desk
   says "Persona is not connected yet.", and the webhook answers 503.

   PRIVACY. The raw webhook body and any Persona response body are
   identity data. They are never logged and never put on an error. The
   event reader returns ids, an event name, a status, a client id, and
   at most one ID type from the catalogue. It does not read a name, a
   date of birth, an address, or a document number, so none of those can
   reach a row, an audit detail, or a log line.

   ID TYPES. A Persona id-class becomes a catalogue code only through
   the table below, and only when shared/id-document-types.js accepts
   that code as ID. `hic` (Canada Health Insurance Card) is not in the
   table, and a code the catalogue does not accept is dropped, so a
   health card never lands as a type. Anything ambiguous (`id`, `cct`)
   is dropped too: an "Identification Card" may be a provincial card or
   another country's, and a citizenship certificate is not the card.
   ============================================================ */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAcceptedIdType, resolveIdType } from "../clients/id-document-types.js";

export const PERSONA_DISCONNECTED = "Persona is not connected yet.";
export const PERSONA_CONNECTED =
  "Persona is connected. Results Persona sends are recorded on the client file. The desk does not start a check yet.";

const API_HOST = "https://api.withpersona.com";
/* Pinned so a Persona default-version change cannot move a field. */
export const PERSONA_API_VERSION = "2023-01-05";
/* Persona signs every attempt, retries included, with the time it was
   sent. Five minutes covers clock skew and nothing else. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

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

/* Persona writes `needs-review`. Older payloads wrote `needs_review`.
   Both are stored as the one word below. */
const STATUSES: Record<string, string> = {
  created: "created",
  pending: "pending",
  completed: "completed",
  approved: "approved",
  declined: "declined",
  "needs-review": "needs_review",
  needs_review: "needs_review",
  failed: "failed",
  expired: "expired",
};

/* Persona id-class to catalogue code. Only unambiguous person types.
   Not here on purpose: hic (health card), id, cct, and every other
   country's own card. */
const ID_CLASS_TO_CATALOGUE: Record<string, string> = {
  dl: "drivers_licence",
  pp: "passport",
  pr: "permanent_resident_card",
};

const CLIENT_ID = /^cli_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID = /^evt_[A-Za-z0-9_-]{1,80}$/;
const INQUIRY_ID = /^inq_[A-Za-z0-9_-]{1,80}$/;
const TEMPLATE_ID = /^(itmpl|itmplv|tmpl)_[A-Za-z0-9_-]{1,80}$/;

export type PersonaEnvironment = "sandbox" | "live" | "unknown";

export interface PersonaConfig {
  apiKey: string;
  webhookSecret: string;
  templateId: string | null;
  environment: PersonaEnvironment;
  apiBase: string;
}

export interface PersonaEventRecord {
  eventId: string;
  eventName: string;
  inquiryId: string;
  status: string;
  clientId: string | null;
  /* A catalogue code the catalogue accepts as ID, or null. */
  idType: string | null;
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
  const templateId = env.PERSONA_TEMPLATE_ID?.trim() ?? "";
  return {
    apiKey,
    webhookSecret,
    templateId: TEMPLATE_ID.test(templateId) ? templateId : null,
    environment: personaEnvironment(apiKey),
    apiBase: configured || API_HOST,
  };
}

export function isClientId(value: string): boolean {
  return CLIENT_ID.test(value);
}

/* Persona-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
   The HMAC is over `${t}.${rawBody}` with the webhook secret.
   While a secret is being rotated the header carries two such sets,
   separated by a space, each with its own t. A set passes when its t is
   within five minutes of now and its v1 matches. Any passing set is
   enough. The comparison is constant-time. */
export function verifyPersonaSignature(input: {
  rawBody: Buffer;
  signature: string;
  secret: string;
  now?: number;
}): boolean {
  if (!input.secret) return false;
  const now = input.now ?? Date.now();
  const sets = input.signature.trim().split(/\s+/).filter(Boolean);
  if (sets.length === 0 || sets.length > 4) return false;
  return sets.some((set) => {
    const parts = set.split(",").map((part) => part.trim()).filter(Boolean);
    const stamps = parts.filter((part) => part.startsWith("t=")).map((part) => part.slice(2));
    const macs = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
    if (stamps.length !== 1 || macs.length === 0) return false;
    const timestamp = stamps[0]!;
    if (!/^\d{1,12}$/.test(timestamp)) return false;
    const at = Number(timestamp) * 1000;
    if (Math.abs(now - at) > MAX_SIGNATURE_AGE_MS) return false;
    const expected = createHmac("sha256", input.secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), input.rawBody]))
      .digest();
    return macs.some((supplied) => {
      if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
      const actual = Buffer.from(supplied, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  });
}

/* null: the body is not an event we can name.
   "ignore": it is an event, and not one this desk stores. */
export function parsePersonaEvent(body: unknown): PersonaEventRecord | "ignore" | null {
  const root = objectOf(objectOf(body).data);
  const attributes = objectOf(root.attributes);
  const eventId = stringOf(root.id);
  const eventName = stringOf(attributes.name);
  if (!eventId || !EVENT_ID.test(eventId) || !eventName) return null;
  if (!EVENT_NAMES.has(eventName)) return "ignore";
  const payload = objectOf(attributes.payload);
  const inquiry = objectOf(payload.data);
  const inquiryId = stringOf(inquiry.id);
  if (!inquiryId || !INQUIRY_ID.test(inquiryId)) return null;
  const inquiryAttributes = objectOf(inquiry.attributes);
  const rawStatus = stringOf(inquiryAttributes.status);
  const reference = stringOf(inquiryAttributes["reference-id"]);
  return {
    eventId,
    eventName,
    inquiryId,
    status: (rawStatus && STATUSES[rawStatus]) || "unknown",
    clientId: reference && isClientId(reference) ? reference : null,
    idType: idTypeOf(payload.included),
  };
}

/* The ID type a passed government-ID verification names, as a catalogue
   code the catalogue accepts, or null. Two passed verifications that
   disagree give null. Only `type`, `status` and `id-class` are read. */
export function idTypeOf(included: unknown): string | null {
  if (!Array.isArray(included)) return null;
  const codes = new Set<string>();
  for (const item of included) {
    const row = objectOf(item);
    if (stringOf(row.type) !== "verification/government-id") continue;
    const attributes = objectOf(row.attributes);
    if (stringOf(attributes.status) !== "passed") continue;
    const idClass = stringOf(attributes["id-class"]);
    codes.add(idClass ? catalogueCodeFor(idClass) ?? "" : "");
  }
  if (codes.size !== 1) return null;
  const [code] = [...codes];
  return code || null;
}

export function catalogueCodeFor(idClass: string): string | null {
  const code = ID_CLASS_TO_CATALOGUE[idClass.toLowerCase()];
  if (!code) return null;
  const row = resolveIdType(code);
  if (!row || row.code !== code || !isAcceptedIdType(code)) return null;
  return code;
}

/* Not called by any route yet. Starting a check from the desk is the
   next job; this is the request it will make. */
export async function createPersonaInquiry(input: {
  config: PersonaConfig;
  referenceId: string;
  templateId?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ inquiryId: string }> {
  const templateId = input.templateId ?? input.config.templateId ?? "";
  if (!TEMPLATE_ID.test(templateId) || !isClientId(input.referenceId)) throw new PersonaRequestError(400);
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
        "persona-version": PERSONA_API_VERSION,
      },
      body: JSON.stringify({
        data: {
          attributes: {
            "inquiry-template-id": templateId,
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
  const inquiryId = stringOf(objectOf(objectOf(parsed).data).id);
  if (!inquiryId || !INQUIRY_ID.test(inquiryId)) throw new PersonaRequestError(502);
  return { inquiryId };
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

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
