/* The document number and the face crop share one AES-256-GCM key.
   ID_NUMBER_KEY is a host secret. It is never written next to the ciphertext.
   Staging and live refuse to encrypt when it is unset. Dev, unit tests, and
   the seam use a fixed key that is not a production secret. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type BinaryLike, type ScryptOptions } from "node:crypto";
import { isProductionRuntime, isStagingRuntime } from "../auth/staging-runtime.js";

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384;
const r = 8;
const p = 1;
const DEV_KEY = "currencydesk-dev-id-number";

export function idNumberKey(env: NodeJS.ProcessEnv = process.env): string {
  const dedicated = env.ID_NUMBER_KEY?.trim();
  if (dedicated) return dedicated;
  if (isStagingRuntime(undefined, env) || isProductionRuntime(env) || env.NODE_ENV === "production") {
    throw new Error("id_number_key_unavailable");
  }
  return DEV_KEY;
}

async function keyFor(salt: Buffer, env: NodeJS.ProcessEnv): Promise<Buffer> {
  return scrypt(idNumberKey(env), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
}

export async function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFor(salt, env);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["aes-256-gcm", salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join("$");
}

export async function decryptSecret(stored: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "aes-256-gcm") throw new Error("id_number_unreadable");
  const salt = Buffer.from(parts[1] ?? "", "base64");
  const iv = Buffer.from(parts[2] ?? "", "base64");
  const tag = Buffer.from(parts[3] ?? "", "base64");
  const ct = Buffer.from(parts[4] ?? "", "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ct.length === 0) throw new Error("id_number_unreadable");
  try {
    const key = await keyFor(salt, env);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("id_number_unreadable");
  }
}

export function last4(full: string): string {
  const trimmed = full.trim();
  return trimmed.slice(-4);
}

export function maskDocumentNumber(full: string): string {
  return `•••• ${last4(full)}`;
}
