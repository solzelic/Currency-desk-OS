/* ============================================================
   Sign-up v2.1: everything country-shaped, from the reservation's
   country (build doc §7). Nothing in the page hard-codes CAD, FINTRAC or
   provinces; it reads this.

   Built on the jurisdiction table the older setup already uses
   (onboarding/flow.ts JURISDICTION) plus the ID line (SIGNUP-LOGIC §4.3):
   the legal line and the recommended line are set per pack, and a pack
   whose numbers Compliance has not confirmed says so (legalIdLine null)
   instead of inventing one.

   COMPLIANCE WORDS (build doc §12) live here, in one place, so they can be
   changed without touching a screen. They are drafts until cleared.
   ============================================================ */
import { JURISDICTION } from "./flow.js";

export type LawRow = { amount: number | null; text: string };

export type SignupPack = {
  code: string;
  country: string;
  regulator: string;
  registration: { label: string; placeholder: string; hint: string };
  homeCurrency: string;
  billingCurrency: string | null;
  idLine: { legal: number | null; recommended: number | null; currency: string };
  law: LawRow[];
  addressFormat: "ca" | "generic";
};

/* Waiting on Compliance (build doc §12). Ship the words when cleared. */
export const COMPLIANCE_WORDS = {
  tourLength: "Two minutes",
  pinNobodyTold: "Only you know it. Nobody at CurrencyDesk is told it.",
  bothFree: "Both free",
  filesNothing: "You review, the desk files nothing without you.",
  struckPrice: 250,
  registrationHintCA: "If you have it, enter it now. No number yet? Skip and add it later.",
  samPreTicked: true,
} as const;

const CA_LAW: LawRow[] = [
  { amount: null, text: "Any amount: a record of every exchange." },
  { amount: 3000, text: "3,000 CAD or more: check ID and record name, address, date of birth and occupation." },
  { amount: 10000, text: "10,000 CAD in cash, adding up over 24 hours: check ID and file a Large Cash Transaction Report within 15 days." },
  { amount: null, text: "Any amount: a Suspicious Transaction Report when something seems wrong." },
];

/** The pack for a reservation's country code ("CA", "US", …). Unknown codes use "XX". */
export function signupPack(code: string | null | undefined): SignupPack {
  const key = code && JURISDICTION[code] ? code : "XX";
  const j = JURISDICTION[key]!;
  const ca = key === "CA";
  return {
    code: key,
    country: j.country,
    regulator: j.regulator,
    registration: {
      label: j.regLabel,
      placeholder: ca ? "M12345678" : "",
      hint: ca ? COMPLIANCE_WORDS.registrationHintCA : "If you have it, enter it now. No number yet? Skip and add it later.",
    },
    homeCurrency: j.currency,
    /* Plans are sold in CAD today (SIGNUP-LOGIC §5.3); only Canadian shops
       are accepted at once, so other packs have no billing currency yet. */
    billingCurrency: ca ? "CAD" : null,
    idLine: ca ? { legal: 3000, recommended: 1000, currency: "CAD" } : { legal: null, recommended: null, currency: j.currency },
    law: ca ? CA_LAW : [],
    addressFormat: ca ? "ca" : "generic",
  };
}
