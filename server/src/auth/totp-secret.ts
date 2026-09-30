/* TOTP secrets have to be readable by the server — that is how a code is
   checked — so they cannot be stored the way a password is, as a one-way
   hash. They are encrypted instead, with the same scrypt parameters the
   password hasher uses, and AES-256-GCM so a flipped bit fails closed.

   The scrypt pepper is PLATFORM_MFA_KEY. It is a host secret, set in the
   environment the way DATABASE_URL is, and it is not derived from
   DATABASE_URL. Rotating the database connection string does not rotate
   authenticators, and a database dump on its own is not a copy of every
   authenticator: the pepper is never written next to the ciphertext.

   Production refuses to encrypt when PLATFORM_MFA_KEY is unset
   (`mfa_key_unavailable`). Boot also refuses to start in that case
   (`server/src/index.ts`). There is no fallback.

   Development, unit tests, and the browser seam leave the variable unset.
   They use the fixed pepper `currencydesk-dev-mfa`, including when
   DATABASE_URL is set for a seam Postgres. That value is not a production
   secret. Set PLATFORM_MFA_KEY locally only when you want to exercise the
   production pepper path.

   Backup codes do not depend on this key: they are scrypt hashes. Changing
   PLATFORM_MFA_KEY makes authenticator codes fail closed (decrypt fails,
   the attempt is a wrong code). A backup code still opens the door. There
   is no self-serve re-enrollment after totp_enrolled_at is set. */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type BinaryLike, type ScryptOptions } from "node:crypto";

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384;
const r = 8;
const p = 1;

function pepper(): string {
  const dedicated = process.env.PLATFORM_MFA_KEY?.trim();
  if (dedicated) return dedicated;
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
