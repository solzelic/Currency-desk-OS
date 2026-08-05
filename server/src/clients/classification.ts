/* ============================================================
   Which side of the line every field falls on.

   The customer record is deliberately split in two, and this file is the
   split written down somewhere a program can read it rather than only
   somewhere a person can.

     IDENTIFYING  legal name, date of birth, ID numbers, scans, the exact
                  street address. Enough, alone or together, to BE this
                  person. It belongs to the desk that collected it, under
                  the consent that desk obtained, and it never leaves.

     SIGNAL       verification status, risk rating, screening outcome and
                  what it matched, region rather than street, the dates.
                  It describes a person without being enough to be them.

   WHY THIS IS A FILE AND NOT A PARAGRAPH IN A DOCUMENT

   The owner intends, later and deliberately, to let one desk learn that
   a person is known to the network — screened, a hit, high risk —
   without ID numbers or scans ever leaving the desk that holds them.
   That is not built here and must not be: it needs a legal basis that is
   the owner's to establish, not this change's to assume.

   What this change owes that decision is that it stays POSSIBLE. The
   migration that untangles personal data from signal after the fact,
   across every desk's live customers, is the one nobody ever gets to do
   — it needs a lawyer, a downtime window and a per-field judgement call
   on data somebody is already trading against.

   So the classification is executable. `signalView` is the only function
   in this codebase that may build a description of a customer for
   somewhere other than the desk holding them, it is built by ALLOW-LIST
   rather than by removing fields, and a test asserts that no identifying
   key can appear in what it returns. A new column added to `desk_clients`
   is invisible to it until somebody names it here, which is the correct
   default: a field nobody has classified is a field nobody may share.

   Nothing calls `signalView` outside its test today. That is the point —
   the shape exists, is proven, and is wired to nothing.

   See docs/CLIENT_RECORDS.md.
   ============================================================ */

/** Every field of the customer record, and which side of the line it is on. */
export const CLASSIFICATION = {
  /* ---- identifying ---- */
  clientId: "identifying",
  legalName: "identifying",
  aliases: "identifying",
  dateOfBirth: "identifying",
  addressLine: "identifying",
  city: "identifying",
  postalCode: "identifying",
  email: "identifying",
  phone: "identifying",
  /* Free text a teller types about a specific human being. Classified
     identifying because it cannot be classified at all — "sister of the
     woman at 14 Elm who came in on Tuesday" identifies two people, and
     there is no way to know in advance that somebody wrote it. */
  notes: "identifying",
  contactName: "identifying",
  contactTitle: "identifying",
  /* A document's number, its issuing government and the day it was
     issued. The scan itself is not even a field here — it is bytes in a
     table this projection does not join. */
  documentNumber: "identifying",
  documentIssuingJurisdiction: "identifying",
  documentIssuedOn: "identifying",
  photograph: "identifying",

  /* ---- signal ---- */
  kind: "signal",
  /* Region and country, never street. A province is a jurisdiction,
     which is what a risk judgement is actually made against; a house
     number is a doorstep somebody can be found at. */
  region: "signal",
  country: "signal",
  occupation: "signal",
  riskRating: "signal",
  verificationStatus: "signal",
  verifiedAt: "signal",
  screeningOutcome: "signal",
  screeningMatched: "signal",
  screenedAt: "signal",
  /* What KIND of document identified them, not which one. "Identified by
     a passport" carries no more about a person than "identified". */
  documentTypes: "signal",
  /* Whether the papers on file are current. The single most useful thing
     one desk could tell another about somebody, and a date of expiry is
     not a way to impersonate anybody. */
  documentsExpireOn: "signal",
  hasCurrentIdentityDocument: "signal",
  /* Incorporation details are a public register entry in every
     jurisdiction shipped here, which is why they sit on this side while
     an individual's date of birth does not. */
  incorporationDate: "signal",
  incorporationJurisdiction: "signal",
  natureOfBusiness: "signal",
  possibleDuplicate: "signal",
  createdAt: "signal",
  updatedAt: "signal",
} as const satisfies Record<string, "identifying" | "signal">;

export type ClientField = keyof typeof CLASSIFICATION;

export const IDENTIFYING_FIELDS = Object.keys(CLASSIFICATION).filter(
  (field) => CLASSIFICATION[field as ClientField] === "identifying",
) as ClientField[];

export const SIGNAL_FIELDS = Object.keys(CLASSIFICATION).filter(
  (field) => CLASSIFICATION[field as ClientField] === "signal",
) as ClientField[];

/**
 * The most that could ever be said about a customer to somebody who is
 * not the desk holding them.
 *
 * Built by allow-list. A field that is not classified above is not in
 * the answer, whatever the caller passed in — the failure mode of a
 * deny-list is a column somebody added and nobody remembered to exclude,
 * and that failure mode is a person's passport number on a wire.
 *
 * NOT WIRED TO ANYTHING. There is no route that returns this and no
 * caller that builds one. It exists so that the day somebody has the
 * legal basis to build cross-desk matching, the shape and the boundary
 * are already here and already tested, rather than being invented under
 * deadline against live data.
 */
export function signalView(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SIGNAL_FIELDS) {
    if (field in record) out[field] = record[field];
  }
  return out;
}
