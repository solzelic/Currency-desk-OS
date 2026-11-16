/* The document number and the face crop share one root key, ID_NUMBER_KEY.
   Each purpose has its own HKDF-SHA256 subkey. The purpose, the tenant,
   and the record id are bound as additional data. A new 96-bit nonce is
   used every time. The fixed dev key is only for NODE_ENV test when
   RENDER_EXTERNAL_HOSTNAME is empty. Decrypt tries the current key, then
   ID_NUMBER_KEY_PREVIOUS. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const KEY_VERSION = 1;
export const PURPOSE_NUMBER = "idv-document-number";
export const PURPOSE_CROP = "idv-face-crop";
export type SecretPurpose = typeof PURPOSE_NUMBER | typeof PURPOSE_CROP;

const DEV_KEY = "currencydesk-dev-id-number";

export type SecretBind = {
  purpose: SecretPurpose;
  tenantId: string;
  recordId: string;
  keyVersion?: number;
};

export function idNumberKey(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.ID_NUMBER_KEY?.trim();
  if (dedicated) return dedicated;
  const host = (env.RENDER_EXTERNAL_HOSTNAME ?? "").trim();
  if (env.NODE_ENV === "test" && host === "") return DEV_KEY;
  throw new Error("id_number_key_unavailable");
}

function subkey(root: string, purpose: SecretPurpose, version: number): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(root, "utf8"),
    Buffer.from(String(version), "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

function additionalData(purpose: SecretPurpose, tenantId: string, recordId: string): Buffer {
  const parts = [purpose, tenantId, recordId].map((part) => Buffer.from(part, "utf8"));
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length);
    chunks.push(len, part);
  }
  return Buffer.concat(chunks);
}

function openWith(stored: string, bind: SecretBind, root: string): string {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "aes-256-gcm") throw new Error("id_number_unreadable");
  const iv = Buffer.from(parts[1] ?? "", "base64");
  const tag = Buffer.from(parts[2] ?? "", "base64");
  const ct = Buffer.from(parts[3] ?? "", "base64");
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) throw new Error("id_number_unreadable");
  const version = bind.keyVersion ?? KEY_VERSION;
  const key = subkey(root, bind.purpose, version);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(additionalData(bind.purpose, bind.tenantId, bind.recordId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export async function encryptSecret(plain: string, bind: SecretBind, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const version = bind.keyVersion ?? KEY_VERSION;
  const key = subkey(idNumberKey(env), bind.purpose, version);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData(bind.purpose, bind.tenantId, bind.recordId));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["aes-256-gcm", iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join("$");
}

export async function decryptSecret(stored: string, bind: SecretBind, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const current = idNumberKey(env);
  try {
    return openWith(stored, bind, current);
  } catch {
    const previous = env.ID_NUMBER_KEY_PREVIOUS?.trim();
    if (!previous) throw new Error("id_number_unreadable");
    try {
      return openWith(stored, bind, previous);
    } catch {
      throw new Error("id_number_unreadable");
    }
  }
}

export function last4(full: string): string {
  const trimmed = full.trim();
  return trimmed.slice(-4);
}

export function maskDocumentNumber(full: string): string {
  return `•••• ${last4(full)}`;
}
