/* ============================================================
   Sign-up v2.1: "Your counter PIN" (SIGNUP-LOGIC §3.3).

   Four digits, typed twice. Refused, on the client and here: four of the
   same, and 1234 ("Not that one. 1234 is the first thing anyone tries.").
   Other weak PINs (a run, a year) are allowed and get the strength label
   "Easy to guess"; the desk's own list (routes/pin.ts isWeakPin) decides
   that label, so both places agree on what is weak.

   NOTE FOR CTO: the desk's PIN change refuses everything isWeakPin
   flags. The pack refuses only four-of-a-kind and 1234 at sign-up, so a
   PIN chosen here (1999, say) would be refused if typed again inside.

   Hashed with Argon2id (the existing PIN verifier accepts both formats), never logged. The owner's PIN is local
   re-auth on a live session only (§3.3); it signs nobody in.
   ============================================================ */
import { hashSignupSecret } from "../auth/password.js";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { isWeakPin } from "../routes/pin.js";

export type PinStrength = "easy" | "okay" | "strong";

export type PinVerdict =
  | { ok: true; strength: PinStrength }
  | { ok: false; reason: "not_four_digits" | "repeat" | "one_two_three_four" | "mismatch"; detail: string };

export function pinStrength(pin: string): PinStrength {
  if (isWeakPin(pin)) return "easy";
  return new Set(pin).size <= 2 ? "okay" : "strong";
}

export function checkPin(pin: string, confirm: string): PinVerdict {
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: "not_four_digits", detail: "Four digits." };
  if (/^(\d)\1{3}$/.test(pin)) return { ok: false, reason: "repeat", detail: "Not 1111 or 1234. Anything else is yours." };
  if (pin === "1234") return { ok: false, reason: "one_two_three_four", detail: "Not that one. 1234 is the first thing anyone tries." };
  if (pin !== confirm) return { ok: false, reason: "mismatch", detail: "Those two don't match. Type it again." };
  return { ok: true, strength: pinStrength(pin) };
}

/** Save the PIN for a verified account. False when the account is not verified. */
export async function savePin(db: Db, enquiryId: string, pin: string): Promise<boolean> {
  const saved = await db.update(schema.signupAccounts)
    .set({ pinHash: await hashSignupSecret(pin), pinSetAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.signupAccounts.enquiryId, enquiryId), eq(schema.signupAccounts.state, "verified")))
    .returning();
  if (!saved.length) return false;
  await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-", action: "signup.pin_set", detail: { enquiryId } });
  return true;
}
