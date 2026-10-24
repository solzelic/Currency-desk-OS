/* One catalogue of identity-document types. The posting gate and the
   read-only audit both read this list. A blank expiry is current only
   when that type's own noExpiryAllowed flag is set. The flag is not a
   pass for every document, and it is not a pass for a date that is
   already past.

   Identified is one current government-issued photo ID. Health cards
   are listed so they are refused on purpose, including a provincial
   name for the same card. A type that is not listed is stored as
   given and is not a photo ID. Dual process and a credit file are
   not rows here: there is no category and no source on the document.

   A known alias is stored as the canonical name. A row already
   stored keeps the spelling it was filed under; the join still
   recognises that spelling. */
export const ID_DOCUMENT_TYPES = [
  { name: "Passport", photo: true, noExpiryAllowed: false, accepted: true },
  {
    name: "Driver's Licence",
    photo: true,
    noExpiryAllowed: false,
    accepted: true,
    aliases: ["Driver licence", "Driver's License", "Drivers Licence", "Drivers License", "Driver License"],
  },
  { name: "Provincial ID", photo: true, noExpiryAllowed: false, accepted: true },
  {
    name: "Permanent Resident Card",
    photo: true,
    noExpiryAllowed: false,
    accepted: true,
    aliases: ["PR Card"],
  },
  /* Since February 2012 IRCC has issued a paper certificate with no
     photograph. The generic name is that paper. It does not identify
     a client. Only the pre-2012 card below does. */
  {
    name: "Citizenship certificate (2012 or later, no photo)",
    photo: false,
    noExpiryAllowed: false,
    accepted: true,
    aliases: ["Citizenship Card"],
  },
  { name: "Canadian citizenship card (pre-2012)", photo: true, noExpiryAllowed: true, accepted: true },
  { name: "Secure Certificate of Indian Status", photo: true, noExpiryAllowed: false, accepted: true },
  {
    name: "Health Card",
    photo: false,
    noExpiryAllowed: false,
    accepted: false,
    aliases: [
      "OHIP",
      "OHIP card",
      "RAMQ",
      "RAMQ card",
      "MSP",
      "MSP card",
      "Alberta Health",
      "Alberta Health Card",
      "Care Card",
    ],
  },
  { name: "Birth certificate", photo: false, noExpiryAllowed: false, accepted: true },
];

/* The same key the join uses. Case, spacing, and punctuation fold
   away. An apostrophe is removed rather than turned into a space, so
   "Driver's Licence" and "Drivers Licence" are one key and "Driver
   licence" stays a different one, listed as its own alias. */
export function typeKey(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/['\u2018\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function catalogueByKey() {
  const seen = new Map();
  for (const row of ID_DOCUMENT_TYPES) {
    for (const name of [row.name, ...(row.aliases ?? [])]) {
      const key = typeKey(name);
      if (!key) throw new Error(`Identity document type has an empty name: ${row.name}`);
      const existing = seen.get(key);
      if (existing && existing !== row) {
        throw new Error(`Identity document type key "${key}" is claimed by "${existing.name}" and "${row.name}"`);
      }
      if (!existing) seen.set(key, row);
    }
  }
  return seen;
}

const CATALOGUE_BY_KEY = catalogueByKey();

/* What a new save should do with a free-text type. A known alias is
   stored as the canonical name. A health card, under any of its
   names, is refused. Anything else is stored trimmed, as given. */
export function resolveIncomingType(value) {
  const stored = String(value ?? "").trim();
  const row = CATALOGUE_BY_KEY.get(typeKey(stored));
  if (!row) return { known: false, refused: false, stored, canonical: null };
  return {
    known: true,
    refused: row.accepted === false,
    stored: row.name,
    canonical: row.name,
  };
}

function sqlText(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/* Same folds as typeKey(), in Postgres. The ASCII apostrophe is
   doubled because it sits inside a SQL string. */
function typeKeySql(expr) {
  const apostrophes = "[''\u2018\u2019]";
  return `btrim(regexp_replace(regexp_replace(regexp_replace(lower(${expr}), '${apostrophes}', '', 'g'), '[^a-z0-9]+', ' ', 'g'), ' +', ' ', 'g'))`;
}

/* The join the standing query uses. The first row carries the types
   so Postgres does not guess them. Each canonical name and each alias
   is its own key, with the parent row's flags. A stored alias keeps
   classifying after the spelling on the row is left alone. */
export function idDocumentTypeJoinSql() {
  const rows = [...CATALOGUE_BY_KEY.entries()].map(([key, row], index) => {
    const name = sqlText(key);
    const photo = row.photo ? "true" : "false";
    const noExpiry = row.noExpiryAllowed ? "true" : "false";
    const accepted = row.accepted ? "true" : "false";
    if (index === 0) {
      return `(${name}::text, ${photo}::boolean, ${noExpiry}::boolean, ${accepted}::boolean)`;
    }
    return `(${name}, ${photo}, ${noExpiry}, ${accepted})`;
  });
  return `LEFT JOIN (VALUES ${rows.join(", ")}) AS id_document_type(name, photo, no_expiry_allowed, accepted) ON id_document_type.name = ${typeKeySql("d.doc_type")}`;
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

/* A new document may not be filed under this name, or under a
   provincial name for the same card. A row already stored is left
   as it is and is still readable. */
export function isHealthCardType(value) {
  return resolveIncomingType(value).refused;
}

/* The name the desk shows. The stored type is not rewritten. A
   citizenship card already stored under the old name is the paper
   certificate IRCC has issued since February 2012. */
export function displayDocumentType(value) {
  const stored = value == null ? "" : String(value);
  if (typeKey(stored) === typeKey("Citizenship Card")) return CITIZENSHIP_CERTIFICATE_LABEL;
  return stored;
}
