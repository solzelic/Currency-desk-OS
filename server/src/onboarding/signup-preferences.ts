import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { withSignupAccount, sha256 } from "./signup-account.js";
import { SAM_CONSENT_TEXT } from "../enquiries/sam.js";
import { maskPhone } from "./email-code.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";

export const SAM_CONSENT_VERSION = sha256(SAM_CONSENT_TEXT);
export type CallChoice = { call: false } | { call: true; version: string; target: string };
type Source = { ipAddress: string; userAgent: string | null };
async function current(db: Db, enquiryId: string) {
  const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0];
  if (!row) throw new Error("signup_reservation_unavailable");
  const latest = (await db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, enquiryId)).orderBy(desc(schema.enquiryCallConsents.at)).limit(1))[0];
  const phone = typeof row.details?.phone === "string" ? row.details.phone : "";
  const canCall = /^\+[1-9][0-9]{6,14}$/.test(phone) && !row.doNotContact;
  const call = canCall && latest?.event === "consent" && latest.phone === phone && latest.consentText === SAM_CONSENT_TEXT;
  return { row, latest, phone, call, preference: { call, canCall, phone: maskPhone(phone), target: sha256(phone), text: SAM_CONSENT_TEXT, version: SAM_CONSENT_VERSION } };
}
/** Post-proof only. A checkbox default is never evidence of consent. */
export async function signupCallPreference(db: Db, enquiryId: string) {
  return (await current(db, enquiryId)).preference;
}
/** The account lock serializes retries, stop/reconsent, and activation. */
export async function saveSignupCallPreference(db: Db, enquiryId: string, choice: CallChoice, source: Source) {
  return withSignupAccount(db, enquiryId, async (db, account) => {
    if (account.state !== "verified") return { ok: false, error: "not_verified" } as const;
    const c = await current(db, enquiryId);
    if (choice.call && (!c.preference.canCall || choice.version !== SAM_CONSENT_VERSION || choice.target !== c.preference.target)) {
      return { ok: false, error: "consent_changed" } as const;
    }
    const event = choice.call ? "consent" : "stop";
    if ((choice.call && !c.call) || (!choice.call && c.latest?.event !== "stop")) {
      const id = randomUUID();
      // Strict order even when stop/reconsent arrive in the same millisecond.
      const at = new Date(Math.max(Date.now(), (c.latest?.at.getTime() ?? 0) + 1));
      await db.insert(schema.enquiryCallConsents).values({ id, enquiryId, event, phone: c.phone,
        consentText: choice.call ? SAM_CONSENT_TEXT : null, ipAddress: source.ipAddress, userAgent: source.userAgent, at });
      await audit(db, { tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-",
        action: choice.call ? "sam.consent_given" : "sam.call_declined",
        detail: { enquiryId, accountId: account.accountId, evidenceId: id, consentVersion: SAM_CONSENT_VERSION } });
    }
    if (!choice.call) await db.update(schema.enquiries).set({ samCallAt: null, details: { ...(c.row.details ?? {}), bestTime: "no call" } }).where(eq(schema.enquiries.id, enquiryId));
    // Consent does not place/schedule a call. Telephony remains a separate gate.
    return { ok: true, preference: { ...c.preference, call: choice.call } } as const;
  });
}
/** An opt-out is effective even if the following payment request fails. */
export async function stopSignupCalls(db: Db, enquiryId: string): Promise<void> {
  await saveSignupCallPreference(db, enquiryId, { call: false }, { ipAddress: "", userAgent: null });
}
