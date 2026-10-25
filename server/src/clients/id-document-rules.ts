/* Shape rules for one identity document, on top of the catalogue.

   The catalogue says which names exist. This says when a saved row
   of that name is allowed, and when a saved row counts toward the
   client file's standing. A birth certificate and a 2012-or-later
   citizenship certificate are not names in the catalogue, so they
   never get here as ID. */
import { LedgerError } from "../ledger/service.js";
import {
  ID_DOCUMENT_TYPES,
  resolveIdType,
  typeKey,
  typeKeySql,
} from "./id-document-types.js";

export const PRE_2012_CUTOFF = "2012-02-01";

export const LAMINATED_STATUS_CARD =
  "Without a secure-card confirmation this is the laminated card, and that card is not accepted as ID.";

export const ID_EXPIRY_REQUIRED = "This photo ID needs an expiry date.";

export const CITIZENSHIP_CARD_ISSUE =
  "A citizenship card counts only when it was issued before 1 February 2012 and checked in person on the original card. A provider result on its own does not.";

export const PHN_NOT_STORED =
  "Record the BC Services Card number or the licence number, never the Personal Health Number.";

const EXPIRY_CODES = new Set([
  "national_id_card",
  "provincial_photo_id",
  "bc_services_card",
  "passport",
  "drivers_licence",
  "permanent_resident_card",
]);

export type IdWrite = {
  docType: string;
  docNumber?: string | null;
  issuedOn?: string | null;
  expiresOn?: string | null;
  secureCard?: boolean;
  inPerson?: boolean;
};

/* A BC Personal Health Number is 10 digits. A card or licence number
   has a letter in it. Spaces and dashes do not make a health number
   into a card number. */
export function looksLikePersonalHealthNumber(value: string | null | undefined): boolean {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return false;
  if (!/^[\d\s-]+$/.test(trimmed)) return false;
  return trimmed.replace(/\D/g, "").length === 10;
}

/**
 * Refuse a document the catalogue name allows but the ruling does not.
 * The caller has already refused unknown types, health cards, and
 * types this shop has switched off.
 */
export function assertIdDocumentShape(input: IdWrite): void {
  const row = resolveIdType(input.docType);
  if (!row || !row.acceptedAsId) return;
  const issued = (input.issuedOn ?? "").trim();
  const expires = (input.expiresOn ?? "").trim();
  if (row.code === "secure_certificate_of_indian_status") {
    if (input.secureCard !== true) throw new LedgerError("LAMINATED_STATUS_CARD", LAMINATED_STATUS_CARD);
    if (!expires) throw new LedgerError("ID_EXPIRY_REQUIRED", ID_EXPIRY_REQUIRED);
    return;
  }
  if (row.code === "citizenship_card") {
    if (input.inPerson !== true || !issued || issued >= PRE_2012_CUTOFF) {
      throw new LedgerError("CITIZENSHIP_CARD_ISSUE_DATE", CITIZENSHIP_CARD_ISSUE);
    }
    return;
  }
  if (EXPIRY_CODES.has(row.code) && !expires) {
    throw new LedgerError("ID_EXPIRY_REQUIRED", ID_EXPIRY_REQUIRED);
  }
  if (row.code === "bc_services_card" && looksLikePersonalHealthNumber(input.docNumber)) {
    throw new LedgerError("HEALTH_NUMBER_NOT_STORED", PHN_NOT_STORED);
  }
}

function keysFor(codes: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  for (const row of ID_DOCUMENT_TYPES) {
    if (!codes.has(row.code)) continue;
    for (const name of [row.code, row.label, ...row.aliases]) {
      const key = typeKey(name);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function sqlList(keys: readonly string[]): string {
  return keys.map((key) => `'${key.replace(/'/g, "''")}'`).join(", ");
}

/* A row that can move the client file to identified. The pre-2012
   citizenship card is the only person photo ID that counts with no
   expiry, and only when it was checked in person. Passport, a driver's
   licence, a PR card, and the other photo cards count only with an
   expiry. A business document has no expiry and counts on its number. */
export function standingDocumentSql(alias: string): string {
  const key = typeKeySql(`${alias}.doc_type`);
  const number = `length(regexp_replace(coalesce(${alias}.doc_number, ''), '[[:space:]]', '', 'g')) > 0`;
  const citizen = sqlList(keysFor(new Set(["citizenship_card"])));
  const scis = sqlList(keysFor(new Set(["secure_certificate_of_indian_status"])));
  const expiry = sqlList(keysFor(EXPIRY_CODES));
  const business = sqlList(
    keysFor(new Set(ID_DOCUMENT_TYPES.filter((row) => row.kind === "business" && row.acceptedAsId).map((row) => row.code))),
  );
  return `${number} AND (
    (${key} IN (${citizen}) AND ${alias}.in_person IS TRUE AND ${alias}.issued_on < DATE '${PRE_2012_CUTOFF}')
    OR (${key} IN (${scis}) AND ${alias}.secure_card IS TRUE AND ${alias}.expires_on IS NOT NULL)
    OR (${key} IN (${expiry}) AND ${alias}.expires_on IS NOT NULL)
    OR (${key} IN (${business}))
  )`;
}
