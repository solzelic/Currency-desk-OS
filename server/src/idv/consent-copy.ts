/* CD-219 wording v0.3.9, still a draft for counsel. One module so it can be swapped.
   The small-photo sentence is included only while this shop keeps the face crop. */

export const CONSENT_VERSION = "consent-v0.3.9-draft";
export const DIDIT_CONSENT_VERSION = "didit-consent-sandbox-v0";

export const ID_DETAILS_LINE = "Your ID details are kept for at least 5 years because the law requires it.";

export const US_REGION_LINE = "Your information is stored and processed in the United States, and may be accessed by courts, law enforcement and national security authorities there.";

export const CROP_LINE = "We also keep a small photo of your face from your ID for 5 years, so staff can compare it with you by eye.";

export const PLACEHOLDER_SHOP = "[Shop legal name]";
export const PLACEHOLDER_PRIVACY = "[Shop privacy officer name or title, email, phone]";
export const PLACEHOLDER_LINK = "[link]";

export type ConsentFill = {
  legalName: string | null;
  privacyContact: string | null;
  privacyEmail: string | null;
  privacyPhone: string | null;
  privacyPolicyUrl: string | null;
  personaNoticeUrl: string | null;
  faceCrop: boolean;
};

function shopName(fill: ConsentFill): string {
  const name = fill.legalName?.trim() ?? "";
  return name || PLACEHOLDER_SHOP;
}

function shownPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return value.trim();
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}

function privacy(fill: ConsentFill): string {
  const phone = fill.privacyPhone?.trim() ? shownPhone(fill.privacyPhone) : "";
  const parts = [fill.privacyContact?.trim() ?? "", fill.privacyEmail?.trim() ?? "", phone].filter(Boolean);
  return parts.length ? parts.join(", ") : PLACEHOLDER_PRIVACY;
}

function link(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  return trimmed || PLACEHOLDER_LINK;
}

export function noticeCopy(fill: ConsentFill): string {
  const shop = shopName(fill);
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
    `Your rights: to see or correct your information, or to ask a question, contact ${privacy(fill)}. Privacy policy: ${link(fill.privacyPolicyUrl)}. Persona's privacy notice: ${link(fill.personaNoticeUrl)}.`,
  ].join("\n");
}

export function selfieConsentCopy(fill: ConsentFill): string {
  const shop = shopName(fill);
  const crop = fill.faceCrop ? ` ${CROP_LINE}` : "";
  return [
    "Optional face match",
    `To check that you are the person on your ID, ${shop} can compare a selfie with the photo on your ID. This uses the shape of your face, which is biometric information.`,
    `The match is done for ${shop} by CurrencyDesk using its provider Persona. Your selfie and ID images are processed and stored in the United States and may be accessed by courts, law enforcement and national security authorities there. They are deleted within 30 days.${crop} ${ID_DETAILS_LINE}`,
    "You do not have to agree. You can show your ID to staff at the counter instead.",
    "I agree to the face match.",
    `Questions: ${privacy(fill)}.`,
  ].join("\n");
}

export function diditNoticeCopy(fill: ConsentFill): string {
  const shop = shopName(fill);
  return [
    "Before we check your ID",
    `${shop} ("we") must verify your identity under Canada's anti-money laundering law for some transactions. We use CurrencyDesk, our software provider, and its identity verification provider Didit to do this for us.`,
    "What we collect: photos of your ID, the details on it, a selfie if you agree, and information about your device. This desk does not keep the ID photos or the selfie.",
    "Why: to confirm your identity, to detect fraud in this check, and to keep the records the law requires.",
    `How long: ${ID_DETAILS_LINE}`,
    "Your choice: you can show your ID to staff at the counter instead.",
    `Your rights: to see or correct your information, or to ask a question, contact ${privacy(fill)}. Privacy policy: ${link(fill.privacyPolicyUrl)}.`,
  ].join("\n");
}

/* The teller scans the ID. There is no selfie and no hand-off.
   FINTRAC still requires the person to match the photo, so the teller attests that. */
export function diditNoSelfieConsentCopy(fill: ConsentFill): string {
  const shop = shopName(fill);
  return [
    "ID scan, no selfie",
    `${shop} ("we") must verify your identity under Canada's anti-money laundering law for some transactions. The teller scans your ID on this shop device. The device stays with the teller. There is no selfie and the device is not handed to you.`,
    "Didit reads the ID. This desk does not keep the ID photo.",
    "The law requires the person to match the photo on the ID. After the scan, the teller compares your face to that photo and records the comparison.",
    ID_DETAILS_LINE,
    "I agree to this ID scan. No selfie is taken.",
    `Questions: ${privacy(fill)}.`,
  ].join("\n");
}

export function diditSelfieConsentCopy(fill: ConsentFill): string {
  const shop = shopName(fill);
  return [
    "Optional face match",
    `To check that you are the person on your ID, ${shop} can compare a selfie with the photo on your ID. This uses the shape of your face, which is biometric information.`,
    `The match is done for ${shop} by CurrencyDesk using its provider Didit. This desk does not keep the selfie or the ID photos. ${ID_DETAILS_LINE}`,
    "You do not have to agree. You can show your ID to staff at the counter instead.",
    "I agree to the face match.",
    `Questions: ${privacy(fill)}.`,
  ].join("\n");
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
