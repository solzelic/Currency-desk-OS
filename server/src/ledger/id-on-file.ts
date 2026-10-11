import type pg from "pg";
import { branchBusinessDate } from "./canada-rules.js";

/* The sentence a teller or an owner sees. One wording, so a 422 from
   the route and a thrown error say the same thing. Matches the client
   file's refusal to take verification standing from the request. */
export const ID_STATUS_NOT_CLIENT_MESSAGE =
  "ID status is not taken from the request. A customer is ID on file only when a typed identity document is on the file, or an approved document record says so.";

/* What a teller sees when the deal needs ID and the file does not
   have it. The checklist and the one-tap Record ID button key off
   this sentence, so the route and the screen stay on one wording.
   canada-rules.ts repeats it for the split-pack refusal; that file
   cannot import this one. */
export const ID_NEEDED_MESSAGE =
  "ID needed for this amount. Record the customer's ID.";

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

/* The word the client file and the ledger customer both return.
   `verified` stays the posting gate's word; the screen says on_file
   so it cannot be confused with a provider check nobody ran. */
export type IdStanding = "on_file" | "missing" | "expired";

export function toIdStanding(status: DerivedIdStatus): IdStanding {
  return status === "verified" ? "on_file" : status;
}

export type DisplayedDocument = {
  docType: string;
  docNumber: string | null;
  expiresOn: string | null;
  isPrimary: boolean;
};

/* Characters that are not part of a document number: ordinary
   whitespace, the other Unicode spaces (NBSP among them), and the
   invisible format characters (zero-width space, joiner, BOM, bidi
   marks). [[:space:]] does not include that set on every cluster,
   and btrim does not either. A number that is only these is empty. */
const NUMBER_STRIP_CLASS = `[ \t\n\r\f\v\u0085\u00A0\u00AD\u034F\u061C\u1680\u180E\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u200B\u200C\u200D\u200E\u200F\u2028\u2029\u202A\u202B\u202C\u202D\u202E\u202F\u205F\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u206A\u206B\u206C\u206D\u206E\u206F\u3000\uFEFF\uFFF9\uFFFA\uFFFB]`;

function strippedNumber(column: string): string {
  return `regexp_replace(coalesce(${column}, ''), '${NUMBER_STRIP_CLASS}', '', 'g')`;
}

/* One document counts when it has a real type, a number that is
   still non-empty after the strip above, and an expiry on or after
   the business date — or no expiry at all.

   No expiry counts as not expired. That is the rule the gate already
   had: a null expires_on did not take the expired leg. A type that
   never expires is not listed separately, because the product has
   never required one.

   is_primary is not in this predicate. It chooses which document is
   shown. A current secondary document is ID on file even when the
   primary is expired, "Not stated", or absent. */
function qualifyingDocument(where: string, businessDateParam: string, current: boolean): string {
  const expiry = current
    ? `AND (d.expires_on IS NULL OR d.expires_on >= ${businessDateParam}::date)`
    : "";
  return `SELECT 1 FROM desk_client_identity_documents d
    WHERE ${where}
      AND coalesce(btrim(d.doc_type), '') <> ''
      AND lower(btrim(d.doc_type)) <> 'not stated'
      AND length(${strippedNumber("d.doc_number")}) > 0
      ${expiry}`;
}

/* Standing of the documents on one client. `businessDateParam` is a
   bound placeholder (`$4`), never a date spliced in from the request. */
export function documentStandingSql(
  clientIdExpr: string,
  tenantExpr: string,
  entityExpr: string,
  businessDateParam: string,
): string {
  const where =
    `d.client_id = ${clientIdExpr}
        AND d.tenant_id = ${tenantExpr}
        AND d.legal_entity_id = ${entityExpr}`;
  return `CASE
    WHEN NOT EXISTS (
      ${qualifyingDocument(where, businessDateParam, false)}
    ) THEN 'missing'
    WHEN NOT EXISTS (
      ${qualifyingDocument(where, businessDateParam, true)}
    ) THEN 'expired'
    ELSE 'verified'
  END`;
}

/* The posting word for a ledger customer. The stored id_status
   column is not read. A row with no client_id cannot see a
   document, so it is missing even when the column says verified. */
export function derivedIdStatusSql(alias: string, businessDateParam: string): string {
  return `CASE
    WHEN ${alias}.client_id IS NULL THEN 'missing'
    ELSE ${documentStandingSql(
      `${alias}.client_id`,
      `${alias}.tenant_id`,
      `${alias}.legal_entity_id`,
      businessDateParam,
    )}
  END`;
}

/**
 * The standing the posting gate may use for this customer.
 *
 * Does not update the row. `at` is the instant the business date is
 * taken from, so a test can stand on either side of midnight in the
 * branch zone. The desk's own calls pass the clock.
 */
export async function derivedIdStatus(
  client: pg.PoolClient,
  customerId: string,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
  at: Date = new Date(),
): Promise<DerivedIdStatus> {
  const businessDate = await branchBusinessDate(client, branchId, at);
  const found = await client.query(
    `SELECT ${derivedIdStatusSql("lc", "$4")} AS id_status
       FROM ledger_customers lc
      WHERE lc.customer_id = $1
        AND lc.tenant_id = $2
        AND lc.legal_entity_id = $3`,
    [customerId, tenantId, legalEntityId, businessDate],
  );
  const status = found.rows[0]?.id_status;
  if (status === "verified" || status === "expired" || status === "missing") return status;
  /* No row, or a value this expression does not produce. The gate
     fails closed: a standing we cannot explain is not ID on file. */
  return "missing";
}

/* The primary document is what the desk shows. When none is marked
   primary, the earliest document is the summary — still not what
   decides the standing. */
export async function displayedDocuments(
  client: pg.PoolClient,
  clientIds: string[],
): Promise<Map<string, DisplayedDocument>> {
  const out = new Map<string, DisplayedDocument>();
  if (!clientIds.length) return out;
  const found = await client.query(
    `SELECT DISTINCT ON (client_id)
            client_id, doc_type, doc_number, expires_on, is_primary
       FROM desk_client_identity_documents
      WHERE client_id = ANY($1::text[])
      ORDER BY client_id, is_primary DESC, created_at`,
    [clientIds],
  );
  for (const row of found.rows) {
    const expires = row.expires_on;
    out.set(row.client_id as string, {
      docType: String(row.doc_type ?? ""),
      docNumber: row.doc_number == null ? null : String(row.doc_number),
      expiresOn: expires == null ? null : new Date(expires as string | Date).toISOString().slice(0, 10),
      isPrimary: row.is_primary === true,
    });
  }
  return out;
}

export type ClientIdFile = {
  idStanding: IdStanding;
  displayedDocument: DisplayedDocument | null;
};

/* Standing for a set of client files, from the same expression the
   posting gate uses. One business date for the branch the actor is
   at: that is the desk's day. */
export async function idFileForClients(
  client: pg.PoolClient,
  branchId: string,
  clientIds: string[],
  at: Date = new Date(),
): Promise<Map<string, ClientIdFile>> {
  const out = new Map<string, ClientIdFile>();
  if (!clientIds.length) return out;
  const businessDate = await branchBusinessDate(client, branchId, at);
  const standing = await client.query(
    `SELECT c.client_id,
            ${documentStandingSql("c.client_id", "c.tenant_id", "c.legal_entity_id", "$2")} AS id_status
       FROM desk_clients c
      WHERE c.client_id = ANY($1::text[])`,
    [clientIds, businessDate],
  );
  const displayed = await displayedDocuments(client, clientIds);
  for (const id of clientIds) {
    out.set(id, {
      idStanding: "missing",
      displayedDocument: displayed.get(id) ?? null,
    });
  }
  for (const row of standing.rows) {
    const status = row.id_status;
    const idStanding: IdStanding =
      status === "verified" || status === "expired" || status === "missing"
        ? toIdStanding(status)
        : "missing";
    const id = row.client_id as string;
    out.set(id, {
      idStanding,
      displayedDocument: displayed.get(id) ?? null,
    });
  }
  return out;
}
