/* ============================================================
   Sign-up v2.1, the password (SIGNUP-LOGIC §3.1 D; SECURITY.md §4).

   At least 12 characters. No forced symbol or mix. Refused if it has
   appeared in a known leak (a range query: only the first five hex
   characters of its SHA-1 leave this server, so the password itself never
   does), or if it is built from a small local list (the shop's name,
   "currency", "password").

   The breach check is an external call, so it has a timeout (standards
   §5.5). If it cannot answer, the password is not accepted and the person
   is told so and offered the other ways in. Accepting an unchecked
   password would quietly drop the rule the screen promised.
   ============================================================ */
import { createHash } from "node:crypto";

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 256;
export const BREACH_TIMEOUT_MS = 3_000;

export type PasswordVerdict =
  | { ok: true }
  | { ok: false; reason: "too_short" | "too_long" | "local_list" | "breached" | "check_unavailable"; detail: string };

/** Counted in characters a person sees, not UTF-16 units. */
export const lengthOf = (pw: string): number => [...pw.normalize("NFC")].length;

const letters = (s: string): string => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");

export function localRefusal(pw: string, shopName: string): boolean {
  const flat = letters(pw);
  const words = ["password", "currency", letters(shopName)].filter((w) => w.length >= 4);
  return words.some((w) => flat.includes(w));
}

/** Asks a range API for SHA-1 suffixes. Resolves to the response body. */
export type RangeFetch = (prefix: string, signal: AbortSignal) => Promise<string>;

export const pwnedRange: RangeFetch = async (prefix, signal) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true", "user-agent": "CurrencyDesk-signup" },
    signal,
  });
  if (!res.ok) throw new Error(`breach range answered ${res.status}`);
  return res.text();
};

/** True when the password's SHA-1 is in the range with a non-zero count. */
export async function isBreached(pw: string, fetchRange: RangeFetch, timeoutMs = BREACH_TIMEOUT_MS): Promise<boolean> {
  const hex = createHash("sha1").update(pw, "utf8").digest("hex").toUpperCase();
  const prefix = hex.slice(0, 5);
  const suffix = hex.slice(5);
  const body = await fetchRange(prefix, AbortSignal.timeout(timeoutMs));
  for (const line of body.split(/\r?\n/)) {
    const [s, count] = line.trim().split(":");
    if (s === suffix && Number(count) > 0) return true;
  }
  return false;
}

export async function checkPassword(pw: string, shopName: string, fetchRange: RangeFetch = pwnedRange): Promise<PasswordVerdict> {
  const n = lengthOf(pw);
  if (n < MIN_LENGTH) return { ok: false, reason: "too_short", detail: "At least 12 characters." };
  if (n > MAX_LENGTH) return { ok: false, reason: "too_long", detail: "That's longer than we can take. Keep it under 256 characters." };
  if (localRefusal(pw, shopName)) {
    return { ok: false, reason: "local_list", detail: "That one's too easy to guess from your shop. Pick another." };
  }
  try {
    if (await isBreached(pw, fetchRange)) {
      return { ok: false, reason: "breached", detail: "That password has appeared in a leak. Pick another." };
    }
  } catch (err) {
    console.warn(`[signup password] breach check unavailable: ${err instanceof Error ? err.name : "error"}`);
    return {
      ok: false, reason: "check_unavailable",
      detail: "We couldn't check that password just now. Try again in a minute, or choose another way to sign in.",
    };
  }
  return { ok: true };
}
