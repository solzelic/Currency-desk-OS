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

/* The words the client file and the ledger customer both return.
   The posting gate still uses verified | expired | missing. The
   screen does not: it shows this object as it arrives. The label
   and the reason are the same sentences displayIdStanding uses,
   so a desk that prefers the server's object says the same thing
   the helper would have said. `tone` is what that helper uses to
   decide whether the checklist is clear. */
export type IdStanding = {
  label: "Identified" | "Expired" | "Missing ID";
  reason: string;
  tone: "ok" | "warning";
};

export const ID_IDENTIFIED_REASON =
  "An identity document with a number is on file, and it has not expired.";
export const ID_EXPIRED_REASON =
  "An identity document on this file is past its expiry. The till will not treat this customer as identified.";
export const ID_NO_EXPIRY_REASON = "ID has no expiry date";
export const ID_NO_NUMBER_REASON = "No ID number";
export const ID_TYPE_NOT_STATED_REASON = "ID type not stated";
export const ID_NO_ID_REASON = "No ID on file";

/* The finer word the document query returns. The gate folds the
   four missing words into `missing`. The response keeps them, so
   the screen can say which one. */
export type IdVerdict =
  | "identified"
  | "expired"
  | "no_expiry"
  | "no_number"
  | "type_not_stated"
  | "no_id";

export function standingForVerdict(verdict: string): IdStanding {
  if (verdict === "identified") {
    return { label: "Identified", reason: ID_IDENTIFIED_REASON, tone: "ok" };
  }
  if (verdict === "expired") {
    return { label: "Expired", reason: ID_EXPIRED_REASON, tone: "warning" };
  }
  const reason =
    verdict === "no_expiry" ? ID_NO_EXPIRY_REASON
    : verdict === "no_number" ? ID_NO_NUMBER_REASON
    : verdict === "type_not_stated" ? ID_TYPE_NOT_STATED_REASON
    : ID_NO_ID_REASON;
  return { label: "Missing ID", reason, tone: "warning" };
}

export function verdictToGate(verdict: string): DerivedIdStatus {
  if (verdict === "identified") return "verified";
  if (verdict === "expired") return "expired";
  return "missing";
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

/* A document the standing will read. A real type is present and is
   not "Not stated". The number has survived the strip. is_primary
   is not here. It chooses which document is shown. */
function countedDocument(where: string): string {
  return `SELECT 1 FROM desk_client_identity_documents d
    WHERE ${where}
      AND coalesce(btrim(d.doc_type), '') <> ''
      AND lower(btrim(d.doc_type)) <> 'not stated'
      AND length(${strippedNumber("d.doc_number")}) > 0`;
}

/* The same order displayIdStanding uses after it has looked at
   every document. A current document wins. A dated document that
   is before the business date wins over a blank expiry. A blank
   expiry then wins over a missing number, which wins over a type
   that was not stated. Anything else is no ID on file.

   The business-date placeholder is on the first two legs. A blank
   expiry is NULL, so it fails both comparisons and lands on
   no_expiry. `businessDateParam` is a bound placeholder, never a
   date spliced in from the request. */
export function documentVerdictSql(
  clientIdExpr: string,
  tenantExpr: string,
  entityExpr: string,
  businessDateParam: string,
): string {
  const where =
    `d.client_id = ${clientIdExpr}
        AND d.tenant_id = ${tenantExpr}
        AND d.legal_entity_id = ${entityExpr}`;
  const counted = countedDocument(where);
  return `CASE
    WHEN EXISTS (
      ${counted}
        AND d.expires_on >= ${businessDateParam}::date
    ) THEN 'identified'
    WHEN EXISTS (
      ${counted}
        AND d.expires_on < ${businessDateParam}::date
    ) THEN 'expired'
    WHEN EXISTS (
      ${counted}
        AND d.expires_on IS NULL
    ) THEN 'no_expiry'
    WHEN EXISTS (
      SELECT 1 FROM desk_client_identity_documents d
       WHERE ${where}
         AND coalesce(btrim(d.doc_type), '') <> ''
         AND lower(btrim(d.doc_type)) <> 'not stated'
         AND length(${strippedNumber("d.doc_number")}) = 0
    ) THEN 'no_number'
    WHEN EXISTS (
      SELECT 1 FROM desk_client_identity_documents d
       WHERE ${where}
         AND (
           lower(btrim(d.doc_type)) = 'not stated'
           OR (
             coalesce(btrim(d.doc_type), '') = ''
             AND length(${strippedNumber("d.doc_number")}) > 0
           )
         )
    ) THEN 'type_not_stated'
    ELSE 'no_id'
  END`;
}

/* The posting word. identified is verified. The four missing
   verdicts are missing. */
export function documentStandingSql(
  clientIdExpr: string,
  tenantExpr: string,
  entityExpr: string,
  businessDateParam: string,
): string {
  return `CASE (${documentVerdictSql(clientIdExpr, tenantExpr, entityExpr, businessDateParam)})
    WHEN 'identified' THEN 'verified'
    WHEN 'expired' THEN 'expired'
    ELSE 'missing'
  END`;
}

/* The posting word for a ledger customer. The stored id_status
   column is not read. A row with no client_id cannot see a
   document, so it is missing even when the column says verified. */
export function derivedIdVerdictSql(alias: string, businessDateParam: string): string {
  return `CASE
    WHEN ${alias}.client_id IS NULL THEN 'no_id'
    ELSE ${documentVerdictSql(
      `${alias}.client_id`,
      `${alias}.tenant_id`,
      `${alias}.legal_entity_id`,
      businessDateParam,
    )}
  END`;
}

export function derivedIdStatusSql(alias: string, businessDateParam: string): string {
  return `CASE (${derivedIdVerdictSql(alias, businessDateParam)})
    WHEN 'identified' THEN 'verified'
    WHEN 'expired' THEN 'expired'
    ELSE 'missing'
  END`;
}

/**
 * The standing the posting gate may use for this customer.
 *
 * Does not update the row. `at` is the instant the business date is
 * taken from, so a test can stand on either side of midnight in the
 * branch zone. The desk's own calls pass the clock.
 */
/**
 * The verdict the response may show for this customer.
 *
 * Does not update the row. `at` is the instant the business date is
 * taken from. The desk's own calls pass the clock.
 */
export async function derivedIdVerdict(
  client: pg.PoolClient,
  customerId: string,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
  at: Date = new Date(),
): Promise<IdVerdict> {
  const businessDate = await branchBusinessDate(client, branchId, at);
  const found = await client.query(
    `SELECT ${derivedIdVerdictSql("lc", "$4")} AS id_verdict
       FROM ledger_customers lc
      WHERE lc.customer_id = $1
        AND lc.tenant_id = $2
        AND lc.legal_entity_id = $3`,
    [customerId, tenantId, legalEntityId, businessDate],
  );
  const verdict = found.rows[0]?.id_verdict;
  if (
    verdict === "identified" ||
    verdict === "expired" ||
    verdict === "no_expiry" ||
    verdict === "no_number" ||
    verdict === "type_not_stated" ||
    verdict === "no_id"
  ) {
    return verdict;
  }
  return "no_id";
}

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
            ${documentVerdictSql("c.client_id", "c.tenant_id", "c.legal_entity_id", "$2")} AS id_verdict
       FROM desk_clients c
      WHERE c.client_id = ANY($1::text[])`,
    [clientIds, businessDate],
  );
  const displayed = await displayedDocuments(client, clientIds);
  for (const id of clientIds) {
    out.set(id, {
      idStanding: standingForVerdict("no_id"),
      displayedDocument: displayed.get(id) ?? null,
    });
  }
  for (const row of standing.rows) {
    const id = row.client_id as string;
    out.set(id, {
      idStanding: standingForVerdict(String(row.id_verdict ?? "")),
      displayedDocument: displayed.get(id) ?? null,
    });
  }
  return out;
}
