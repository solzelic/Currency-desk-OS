/* Outbound Persona calls other than creating an inquiry. Each one asserts
   the key before the network. The face crop is never sent. */
import { cropIdPortrait, isSmallCrop } from "./face-crop.js";
import { personaFileHost } from "./inquiry-text.js";
import { assertPersonaKey, personaFetch } from "./persona-guard.js";
import { PERSONA_API_BASE_DEFAULT, PERSONA_VERSION } from "./providers/persona/index.js";

const PHOTO_CAP = 6_000_000;

function baseOf(env: NodeJS.ProcessEnv): string {
  return (env.PERSONA_API_BASE?.trim() || PERSONA_API_BASE_DEFAULT).replace(/\/$/, "");
}

function headers(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    accept: "application/json",
    "content-type": "application/json",
    "key-inflection": "kebab",
    "persona-version": PERSONA_VERSION,
  };
}

export async function fetchPersonaInquiry(input: {
  inquiryId: string;
  key: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  const res = await personaFetch({
    key: input.key, env: input.env, base: baseOf(input.env),
    path: `/inquiries/${encodeURIComponent(input.inquiryId)}?include=verifications`,
    init: { method: "GET", headers: headers(input.key) },
    fetchImpl: input.fetchImpl,
  });
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new Error("inquiry_fetch_failed");
  }
  return res.json() as Promise<unknown>;
}

export async function generateOneTimeLink(input: {
  inquiryId: string;
  key: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const res = await personaFetch({
    key: input.key, env: input.env, base: baseOf(input.env),
    path: `/inquiries/${encodeURIComponent(input.inquiryId)}/generate-one-time-link`,
    init: { method: "POST", headers: headers(input.key), body: "{}" },
    fetchImpl: input.fetchImpl,
  });
  if (res.status !== 200 && res.status !== 201) {
    await res.body?.cancel();
    throw new Error("link_failed");
  }
  const payload = obj(await res.json());
  const link = obj(payload.meta)["one-time-link"];
  if (typeof link !== "string" || !personaOneTimeLink(link)) throw new Error("link_refused");
  return link.trim();
}

/* The link the customer opens. https only, and only a Persona host. */
export function personaOneTimeLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (url.port !== "" && url.port !== "443") return false;
    const host = url.hostname.toLowerCase();
    return host === "withpersona.com" || host.endsWith(".withpersona.com");
  } catch {
    return false;
  }
}

async function readBounded(res: Response, cap: number): Promise<Buffer | null> {
  const declared = res.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > cap) {
      await res.body?.cancel();
      return null;
    }
  }
  const body = res.body;
  if (!body) {
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > cap) return null;
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      total += step.value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return null;
      }
      chunks.push(step.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  if (total === 0) return null;
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/* Downloads the ID front photo only. A selfie URL, or any other host, is not requested.
   The bytes are cropped and then dropped. Nothing here sends the crop back out. */
export async function cropFromFrontPhoto(input: {
  url: string | null;
  key: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<Buffer | null> {
  const url = input.url?.trim() ?? "";
  if (!url || !personaFileHost(url, input.env) || /selfie/i.test(url)) return null;
  assertPersonaKey(input.key, input.env, baseOf(input.env));
  const fetchImpl = input.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { method: "GET", redirect: "manual" });
  if (res.status !== 200) {
    await res.body?.cancel();
    return null;
  }
  const bytes = await readBounded(res, PHOTO_CAP);
  if (!bytes) return null;
  const crop = cropIdPortrait(bytes);
  if (!crop || !isSmallCrop(crop) || crop.equals(bytes)) return null;
  return crop;
}
