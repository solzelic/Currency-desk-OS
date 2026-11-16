/* Text fields from a Persona inquiry. Photo, file, and URL attributes are
   dropped. The only URL kept, and only in memory, is the government-id
   front photo, which is the source of the face crop. Selfie URLs are not
   copied out. */

const TEXT_KEYS = new Set([
  "name-first", "name-middle", "name-last", "name-suffix",
  "identification-number", "id-class",
  "issuing-subdivision", "issuing-country",
  "expiration-date", "birthdate",
  "address-street-1", "address-street-2", "address-city",
  "address-subdivision", "address-postal-code", "address-country-code",
  "status",
]);

export type InquiryText = {
  name: string | null;
  identificationNumber: string | null;
  idClass: string | null;
  issuingSubdivision: string | null;
  issuingCountry: string | null;
  expirationDate: string | null;
  birthdate: string | null;
  address: string | null;
  governmentIdVerificationId: string | null;
  selfieVerificationId: string | null;
  selfieStatus: string | null;
  templateId: string | null;
  templateVersion: string | null;
  frontPhotoUrl: string | null;
  status: string | null;
};

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOf(attributes: Record<string, unknown>, key: string): string | null {
  const value = attributes[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || trimmed.startsWith("data:")) return null;
  return trimmed;
}

function textMap(attributes: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of TEXT_KEYS) {
    const value = textOf(attributes, key);
    if (value) out[key] = value;
  }
  return out;
}

function frontUrl(attributes: Record<string, unknown>): string | null {
  const direct = attributes["front-photo-url"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const photo = obj(attributes["front-photo"]);
  const nested = photo.url;
  return typeof nested === "string" && nested.trim() ? nested.trim() : null;
}

export function personaFileHost(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.port !== "" && url.port !== "443") return false;
    const host = url.hostname.toLowerCase();
    return host === "files.withpersona.com" || host === "withpersona.com" || host.endsWith(".withpersona.com");
  } catch {
    return false;
  }
}

export function readInquiryText(body: unknown): InquiryText {
  const root = obj(body);
  const data = obj(root.data);
  const attributes = textMap(obj(data.attributes));
  const included = Array.isArray(root.included) ? root.included : [];
  let government: Record<string, string> = {};
  let governmentId: string | null = null;
  let selfieId: string | null = null;
  let selfieStatus: string | null = null;
  let frontPhotoUrl: string | null = null;
  for (const item of included) {
    const row = obj(item);
    const type = typeof row.type === "string" ? row.type : "";
    const id = typeof row.id === "string" ? row.id : "";
    const fields = obj(row.attributes);
    if (type.includes("government-id")) {
      government = textMap(fields);
      governmentId = id || null;
      frontPhotoUrl = frontUrl(fields);
    } else if (type.includes("selfie")) {
      selfieId = id || null;
      selfieStatus = textOf(fields, "status");
    }
  }
  const name = [government["name-first"] ?? attributes["name-first"], government["name-last"] ?? attributes["name-last"]]
    .filter(Boolean).join(" ").trim();
  const address = [
    government["address-street-1"], government["address-street-2"], government["address-city"],
    government["address-subdivision"], government["address-postal-code"], government["address-country-code"],
  ].filter(Boolean).join(", ");
  const relationships = obj(data.relationships);
  const template = obj(obj(relationships["inquiry-template"]).data);
  const version = obj(obj(relationships["inquiry-template-version"]).data);
  return {
    name: name || null,
    identificationNumber: government["identification-number"] ?? null,
    idClass: government["id-class"] ?? null,
    issuingSubdivision: government["issuing-subdivision"] ?? null,
    issuingCountry: government["issuing-country"] ?? null,
    expirationDate: government["expiration-date"] ?? null,
    birthdate: government["birthdate"] ?? null,
    address: address || null,
    governmentIdVerificationId: governmentId,
    selfieVerificationId: selfieId,
    selfieStatus,
    templateId: typeof template.id === "string" ? template.id : null,
    templateVersion: typeof version.id === "string" ? version.id : null,
    frontPhotoUrl,
    status: attributes.status ?? government.status ?? null,
  };
}

/* What a stored record may keep. The front photo URL is not in here. */
export function storedInquiryFields(text: InquiryText): Record<string, string | null> {
  return {
    name: text.name,
    identificationNumber: text.identificationNumber,
    idClass: text.idClass,
    issuingSubdivision: text.issuingSubdivision,
    issuingCountry: text.issuingCountry,
    expirationDate: text.expirationDate,
    birthdate: text.birthdate,
    address: text.address,
    governmentIdVerificationId: text.governmentIdVerificationId,
    selfieVerificationId: text.selfieVerificationId,
    selfieStatus: text.selfieStatus,
    templateId: text.templateId,
    templateVersion: text.templateVersion,
    status: text.status,
  };
}
