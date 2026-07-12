/* ============================================================
   Password hashing — scrypt via node:crypto.
   Zero native dependencies (unlike argon2/bcrypt), memory-hard,
   and OWASP-acceptable at these parameters. Format:
     scrypt$N$r$p$saltB64$hashB64
   so parameters can be raised later without invalidating stored
   hashes — verify() reads them from the stored string.
   ============================================================ */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const N = 16384; // cost (2^14)
const r = 8;
const p = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const n = Number(nStr), rr = Number(rStr), pp = Number(pStr);
  if (!Number.isFinite(n) || !Number.isFinite(rr) || !Number.isFinite(pp)) return false;
  const salt = Buffer.from(saltB64!, "base64");
  const expected = Buffer.from(hashB64!, "base64");
  const actual = await scrypt(password, salt, expected.length, { N: n, r: rr, p: pp, maxmem: 128 * n * rr * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
