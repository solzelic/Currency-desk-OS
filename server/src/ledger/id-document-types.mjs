/* One catalogue of identity-document types. The desk label and the
   server standing both read this list. A blank expiry is current only
   when that type's own noExpiryAllowed flag is set. The flag is not a
   pass for every document, and it is not a pass for a date that is
   already past.

   Identified is one current government-issued photo ID, and only the
   primary paper can be that ID. A non-primary document never
   identifies the client. Health cards are listed so they are refused
   on purpose. A type that is not listed is not a photo ID. The
   laminated Certificate of Indian Status is not listed. Dual
   process and a credit file are not rows here: there is no category
   and no source on the document. */
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

/* The join a standing query uses. The first row carries the types
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
