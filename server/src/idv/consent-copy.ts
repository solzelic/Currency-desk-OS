/* CD-219 wording v0.3.9, still a draft for counsel. One module so it can be swapped.
   The small-photo sentence is included only while this shop keeps the face crop. */

/* The previous versions are what a stored consent row was shown.
   A new agreement uses the current versions. Past rows still resolve
   through consentCopy() with the version on the row. */
export const CONSENT_VERSION_PREVIOUS = "consent-v0.3.9-draft";
export const CONSENT_VERSION = "consent-v0.3.10-draft";
export const DIDIT_CONSENT_VERSION_PREVIOUS = "didit-consent-sandbox-v0";
export const DIDIT_CONSENT_VERSION = "didit-consent-sandbox-v1";

export const ID_DETAILS_LINE = "Your ID details are kept for at least 5 years because the law requires it.";

export const US_REGION_LINE = "Your information is stored and processed in the United States, and may be accessed by courts, law enforcement and national security authorities there.";

export const CROP_LINE = "We also keep a small photo of your face from your ID for 5 years, so staff can compare it with you by eye.";

/* Shown to a customer when the shop has not filled the field.
   Draft wording for Compliance review (CD-219). A bracket placeholder
   is never shown. privacyReady still requires the real fields, so a
   staging customer link stays blocked until the owner sets them. */
export const FALLBACK_SHOP = "This shop";
export const FALLBACK_PRIVACY = "the staff at this counter";

export type ConsentFill = {
  legalName: string | null;
  privacyContact: string | null;
  privacyEmail: string | null;
  privacyPhone: string | null;
  privacyPolicyUrl: string | null;
  personaNoticeUrl: string | null;
  faceCrop: boolean;
};

type Wording = "current" | "legacy";

function shopName(fill: ConsentFill, wording: Wording = "current"): string {
  const name = fill.legalName?.trim() ?? "";
  if (name) return name;
  return wording === "legacy" ? "[Shop legal name]" : FALLBACK_SHOP;
}

function shownPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return value.trim();
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}

function privacy(fill: ConsentFill, wording: Wording = "current"): string {
  const phone = fill.privacyPhone?.trim() ? shownPhone(fill.privacyPhone) : "";
  const parts = [fill.privacyContact?.trim() ?? "", fill.privacyEmail?.trim() ?? "", phone].filter(Boolean);
  if (parts.length) return parts.join(", ");
  return wording === "legacy" ? "[Shop privacy officer name or title, email, phone]" : FALLBACK_PRIVACY;
}

function policySentence(fill: ConsentFill, wording: Wording = "current"): string {
  const url = fill.privacyPolicyUrl?.trim() ?? "";
  if (url) return ` Privacy policy: ${url}.`;
  return wording === "legacy" ? " Privacy policy: [link]." : "";
}

function personaNoticeSentence(fill: ConsentFill, wording: Wording = "current"): string {
  const url = fill.personaNoticeUrl?.trim() ?? "";
  if (url) return ` Persona's privacy notice: ${url}.`;
  return wording === "legacy" ? " Persona's privacy notice: [link]." : "";
}

export function noticeCopy(fill: ConsentFill, wording: Wording = "current"): string {
  const shop = shopName(fill, wording);
  const crop = fill.faceCrop ? ` ${CROP_LINE}` : "";
  return [
    "Before we check your ID",
    `${shop} ("we") must verify your identity under Canada's anti-money laundering law for some transactions. We use CurrencyDesk, our software provider, and its identity verification provider Persona to do this for us.`,
    "What we collect: photos of your ID, the details on it, a selfie if you agree, and information about your device.",
    "Why: to confirm your identity, to detect fraud in this check, and to keep the records the law requires.",
    `Where: ${US_REGION_LINE}`,
    "Fraud prevention by Persona: Persona may also use your information to prevent fraud.",
    `How long: ID photos and selfies are deleted within 30 days.${crop} ${ID_DETAILS_LINE} Persona may keep some device information longer to prevent fraud.`,
    "Your choice: you can show your ID to staff at the counter instead.",
    `Your rights: to see or correct your information, or to ask a question, contact ${privacy(fill, wording)}.${policySentence(fill, wording)}${personaNoticeSentence(fill, wording)}`,
  ].join("\n");
}

export function selfieConsentCopy(fill: ConsentFill, wording: Wording = "current"): string {
  const shop = shopName(fill, wording);
  const crop = fill.faceCrop ? ` ${CROP_LINE}` : "";
  return [
    "Optional face match",
    `To check that you are the person on your ID, ${shop} can compare a selfie with the photo on your ID. This uses the shape of your face, which is biometric information.`,
    `The match is done for ${shop} by CurrencyDesk using its provider Persona. Your selfie and ID images are processed and stored in the United States and may be accessed by courts, law enforcement and national security authorities there. They are deleted within 30 days.${crop} ${ID_DETAILS_LINE}`,
    "You do not have to agree. You can show your ID to staff at the counter instead.",
    "I agree to the face match.",
    `Questions: ${privacy(fill, wording)}.`,
  ].join("\n");
}

/* Didit customer copy needs Data and Privacy Lead approval before live (#825).
   Empty-field wording is still a draft for Compliance review (CD-219). */
export function diditNoticeCopy(fill: ConsentFill, wording: Wording = "current"): string {
  const shop = shopName(fill, wording);
  return [
    "Before we check your ID",
    `${shop} ("we") must verify your identity under Canada's anti-money laundering law for some transactions. We use CurrencyDesk, our software provider, and its identity verification provider Didit to do this for us.`,
    "What we collect: photos of your ID, the details on it, a selfie if you agree, and information about your device. This desk does not keep the ID photos or the selfie.",
    "Why: to confirm your identity, to detect fraud in this check, and to keep the records the law requires.",
    `How long: ${ID_DETAILS_LINE}`,
    "Your choice: you can show your ID to staff at the counter instead.",
    `Your rights: to see or correct your information, or to ask a question, contact ${privacy(fill, wording)}.${policySentence(fill, wording)}`,
  ].join("\n");
}

/* The teller scans the ID. There is no selfie and no hand-off.
   The law still requires the person to match the photo, so the teller attests that. */
export function diditNoSelfieConsentCopy(fill: ConsentFill, wording: Wording = "current"): string {
  const shop = shopName(fill, wording);
  return [
    "ID scan, no selfie",
    `${shop} ("we") must verify your identity under Canada's anti-money laundering law for some transactions. The teller scans your ID on this shop device. The device stays with the teller. There is no selfie and the device is not handed to you.`,
    "Didit reads the ID. This desk does not keep the ID photo.",
    "The law requires the person to match the photo on the ID. After the scan, the teller compares your face to that photo and records the comparison.",
    ID_DETAILS_LINE,
    "I agree to this ID scan. No selfie is taken.",
    `Questions: ${privacy(fill, wording)}.`,
  ].join("\n");
}

export function diditSelfieConsentCopy(fill: ConsentFill, wording: Wording = "current"): string {
  const shop = shopName(fill, wording);
  return [
    "Optional face match",
    `To check that you are the person on your ID, ${shop} can compare a selfie with the photo on your ID. This uses the shape of your face, which is biometric information.`,
    `The match is done for ${shop} by CurrencyDesk using its provider Didit. This desk does not keep the selfie or the ID photos. ${ID_DETAILS_LINE}`,
    "You do not have to agree. You can show your ID to staff at the counter instead.",
    "I agree to the face match.",
    `Questions: ${privacy(fill, wording)}.`,
  ].join("\n");
}

export type ConsentPiece = "notice" | "selfie" | "didit-notice" | "didit-selfie" | "didit-no-selfie";

/* A stored consent names the version the customer read. The current
   functions are the new wording. The previous version still builds the
   bracket placeholders and the link sentences that were on screen then. */
export function consentCopy(piece: ConsentPiece, version: string, fill: ConsentFill): string {
  const wording: Wording = version === CONSENT_VERSION_PREVIOUS || version === DIDIT_CONSENT_VERSION_PREVIOUS
    ? "legacy"
    : "current";
  if (piece === "selfie") return selfieConsentCopy(fill, wording);
  if (piece === "didit-notice") return diditNoticeCopy(fill, wording);
  if (piece === "didit-selfie") return diditSelfieConsentCopy(fill, wording);
  if (piece === "didit-no-selfie") return diditNoSelfieConsentCopy(fill, wording);
  return noticeCopy(fill, wording);
}

export function privacyReady(fill: ConsentFill): boolean {
  return Boolean(
    fill.legalName?.trim()
    && fill.privacyContact?.trim()
    && fill.privacyEmail?.trim()
    && fill.privacyPhone?.trim()
    && fill.privacyPolicyUrl?.trim(),
  );
}
