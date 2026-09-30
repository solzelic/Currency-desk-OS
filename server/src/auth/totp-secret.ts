/* TOTP secrets have to be readable by the server — that is how a code is
   checked — so they cannot be stored the way a password is, as a one-way
   hash. They are encrypted instead, with the same scrypt parameters the
   password hasher uses, and AES-256-GCM so a flipped bit fails closed.

   The scrypt pepper is PLATFORM_MFA_KEY when the host has set one, and
   otherwise DATABASE_URL. Neither value is written next to the ciphertext,
   so a database dump on its own is not a copy of every authenticator.
   Backup codes do not depend on this key: they are scrypt hashes. If the
   pepper changes (a new database URL, a rotated key) the authenticator
   codes stop verifying and the backup codes still open the door.

   Development and test run on the embedded database and have no
   DATABASE_URL. They use a fixed pepper so a single process can enroll
   and then verify. That value is not a production secret: production
   refuses to encrypt unless PLATFORM_MFA_KEY or DATABASE_URL is set. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type BinaryLike, type ScryptOptions } from "node:crypto";

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384;
const r = 8;
const p = 1;

function pepper(): string {
  const dedicated = process.env.PLATFORM_MFA_KEY?.trim();
  if (dedicated) return dedicated;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return databaseUrl;
  if (process.env.NODE_ENV === "production") {
    throw new Error("mfa_key_unavailable");
  }
  return "currencydesk-dev-mfa";
}

async function keyFor(salt: Buffer): Promise<Buffer> {
  return scrypt(pepper(), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
}

/* aes-256-gcm$salt$iv$tag$ciphertext — base64 parts, `$` is not in that
   alphabet, same shape as the scrypt$password strings. */
export async function encryptSecret(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFor(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["aes-256-gcm", salt.toString("base64"), iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join("$");
}

export async function decryptSecret(stored: string): Promise<string> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "aes-256-gcm") throw new Error("mfa_secret_unreadable");
  const salt = Buffer.from(parts[1]!, "base64");
  const iv = Buffer.from(parts[2]!, "base64");
  const tag = Buffer.from(parts[3]!, "base64");
  const ct = Buffer.from(parts[4]!, "base64");
  if (salt.length === 0 || iv.length === 0 || tag.length === 0 || ct.length === 0) {
    throw new Error("mfa_secret_unreadable");
  }
  try {
    const key = await keyFor(salt);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("mfa_secret_unreadable");
  }
}
