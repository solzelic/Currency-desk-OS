import type pg from "pg";

/* The sentence a teller or an owner sees. One wording, so a 422 from
   the route and a thrown error say the same thing. Matches the client
   file's refusal to take verification standing from the request. */
export const ID_STATUS_NOT_CLIENT_MESSAGE =
  "ID status is not taken from the request. A customer is ID on file only when a typed identity document is on the file, or an approved document record says so.";

/* Spellings of a standing a request must not carry. Compared with
   underscores and hyphens removed, so idStatus, id_status and id-status
   are one key. `verified` on its own is the flag form. */
const STATUS_KEYS = new Set([
  "idstatus",
  "kycstatus",
  "verified",
  "idverified",
  "isverified",
  "identityverified",
  "kycverified",
]);

/* A nested `status` is the same claim when it sits under one of these. */
const STATUS_PARENTS = new Set(["kyc", "identity", "identification", "id"]);

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/**
 * True when the body, at any depth, names an ID standing or a verified
 * flag. The value does not matter: sending `missing` is still the
 * caller deciding the standing. A name that happens to be the word
 * "verified" is a value, not a key, and is not this.
 */
export function requestCarriesIdStatus(body: unknown, parent = ""): boolean {
  if (body == null || typeof body !== "object") return false;
  if (Array.isArray(body)) {
    return body.some((item) => requestCarriesIdStatus(item, parent));
  }
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const norm = normalizeKey(key);
    if (STATUS_KEYS.has(norm)) return true;
    const parentNorm = normalizeKey(parent);
    if (
      STATUS_PARENTS.has(parentNorm) &&
      (norm === "status" || norm === "outcome" || norm === "verified")
    ) {
      return true;
    }
    if (value != null && typeof value === "object" && requestCarriesIdStatus(value, key)) {
      return true;
    }
  }
  return false;
}

export type DerivedIdStatus = "verified" | "expired" | "missing";

/* The posting word, from the documents on the client the ledger row
   points at. The stored `id_status` column is deliberately not in this
   expression. A row that already says verified, and has no document,
   stays that way in the table and is `missing` here.

   A typed document has a type and a number. "Not stated" is the old
   placeholder for a row opened before anyone had read the paper.
   A primary document past its expiry is not on file. An approved
   provider document would be a row in the same table; no provider is
   connected, so a standing word on the client is not a substitute. */
export function derivedIdStatusSql(alias: string): string {
  const doc = (extra: string) =>
    `SELECT 1 FROM desk_client_identity_documents d
      WHERE d.client_id = ${alias}.client_id
        AND d.tenant_id = ${alias}.tenant_id
        AND d.legal_entity_id = ${alias}.legal_entity_id
        ${extra}`;
  return `CASE
    WHEN ${alias}.client_id IS NULL THEN 'missing'
    WHEN NOT EXISTS (
      ${doc(`AND coalesce(btrim(d.doc_type), '') <> ''
        AND lower(btrim(d.doc_type)) <> 'not stated'
        AND coalesce(btrim(d.doc_number), '') <> ''`)}
    ) THEN 'missing'
    WHEN EXISTS (
      ${doc(`AND d.is_primary
        AND d.expires_on IS NOT NULL
        AND d.expires_on < current_date`)}
    ) THEN 'expired'
    ELSE 'verified'
  END`;
}

/**
 * The standing the posting gate may use for this customer.
 *
 * Does not update the row. Existing customers stored as verified with
 * no document are missing until a document record exists.
 */
export async function derivedIdStatus(
  client: pg.PoolClient,
  customerId: string,
  tenantId: string,
  legalEntityId: string,
): Promise<DerivedIdStatus> {
  const found = await client.query(
    `SELECT ${derivedIdStatusSql("lc")} AS id_status
       FROM ledger_customers lc
      WHERE lc.customer_id = $1
        AND lc.tenant_id = $2
        AND lc.legal_entity_id = $3`,
    [customerId, tenantId, legalEntityId],
  );
  const status = found.rows[0]?.id_status;
  if (status === "verified" || status === "expired" || status === "missing") return status;
  /* No row, or a value this expression does not produce. The gate
     fails closed: a standing we cannot explain is not ID on file. */
  return "missing";
}
