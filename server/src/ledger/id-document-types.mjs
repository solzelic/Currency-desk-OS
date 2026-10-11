/* One catalogue of identity-document types. The posting gate and the
   read-only audit both read this list. A blank expiry is current only
   when that type's own noExpiryAllowed flag is set. The flag is not a
   pass for every document, and it is not a pass for a date that is
   already past.

   Identified is one current government-issued photo ID. Health cards
   are listed so they are refused on purpose. A type that is not listed
   is not a photo ID. Dual process and a credit file are not rows here:
   there is no category and no source on the document. */
export const ID_DOCUMENT_TYPES = [
  { name: "Passport", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Driver's Licence", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Driver licence", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Driver's License", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Provincial ID", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "PR Card", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Permanent Resident Card", photo: true, noExpiryAllowed: false, accepted: true },
  /* Since February 2012 IRCC has issued a paper certificate with no
     photograph. This generic name is that paper. It does not identify
     a client. Only the pre-2012 card below does. */
  { name: "Citizenship Card", photo: false, noExpiryAllowed: false, accepted: true },
  { name: "Citizenship certificate (2012 or later, no photo)", photo: false, noExpiryAllowed: false, accepted: true },
  { name: "Canadian citizenship card (pre-2012)", photo: true, noExpiryAllowed: true, accepted: true },
  { name: "Secure Certificate of Indian Status", photo: true, noExpiryAllowed: false, accepted: true },
  { name: "Health Card", photo: false, noExpiryAllowed: false, accepted: false },
  { name: "Birth certificate", photo: false, noExpiryAllowed: false, accepted: true },
];

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/* The join the standing query uses. The first row carries the types
   so Postgres does not guess them. Names are matched after trim and
   lower-case. */
export function idDocumentTypeJoinSql() {
  const rows = ID_DOCUMENT_TYPES.map((row, index) => {
    const name = sqlText(row.name.toLowerCase());
    const photo = row.photo ? "true" : "false";
    const noExpiry = row.noExpiryAllowed ? "true" : "false";
    const accepted = row.accepted ? "true" : "false";
    if (index === 0) {
      return `(${name}::text, ${photo}::boolean, ${noExpiry}::boolean, ${accepted}::boolean)`;
    }
    return `(${name}, ${photo}, ${noExpiry}, ${accepted})`;
  });
  return `LEFT JOIN (VALUES ${rows.join(", ")}) AS id_document_type(name, photo, no_expiry_allowed, accepted) ON id_document_type.name = lower(btrim(d.doc_type))`;
}

/* A photo ID that is still current. A null expiry qualifies only on
   a row whose flag says so. A recorded expiry that is before the
   business date does not, including on that row. */
export function currentPhotoSql(dateExpr) {
  return `id_document_type.photo IS TRUE
      AND id_document_type.accepted IS TRUE
      AND (
        d.expires_on >= (${dateExpr})::date
        OR (d.expires_on IS NULL AND id_document_type.no_expiry_allowed IS TRUE)
      )`;
}

export function expiredPhotoSql(dateExpr) {
  return `id_document_type.photo IS TRUE
      AND id_document_type.accepted IS TRUE
      AND d.expires_on < (${dateExpr})::date`;
}

export function photoMissingExpirySql() {
  return `id_document_type.photo IS TRUE
      AND id_document_type.accepted IS TRUE
      AND d.expires_on IS NULL
      AND id_document_type.no_expiry_allowed IS NOT TRUE`;
}

/* A paper that is not an accepted photo ID, dated on or after the
   business date. It does not identify the client. It also does not
   let an expired photo ID stand as the verdict. */
export function currentNonPhotoSql(dateExpr) {
  return `NOT (id_document_type.photo IS TRUE AND id_document_type.accepted IS TRUE)
      AND d.expires_on >= (${dateExpr})::date`;
}

export function nonPhotoSql() {
  return `NOT (id_document_type.photo IS TRUE AND id_document_type.accepted IS TRUE)`;
}

export const HEALTH_CARD_REFUSAL =
  "Health cards can't be used as ID. Record a current photo ID.";

export const CITIZENSHIP_CERTIFICATE_LABEL =
  "Citizenship certificate (2012 or later, no photo)";

/* A new document may not be filed under this name. A row already
   stored is left as it is and is still readable. */
export function isHealthCardType(value) {
  return String(value ?? "").trim().toLowerCase() === "health card";
}

/* The name the desk shows. The stored type is not rewritten. The
   generic citizenship card is the paper certificate IRCC has issued
   since February 2012. */
export function displayDocumentType(value) {
  const stored = value == null ? "" : String(value);
  if (stored.trim().toLowerCase() === "citizenship card") return CITIZENSHIP_CERTIFICATE_LABEL;
  return stored;
}
