import type pg from "pg";
import { civilTodayInZone } from "../civil-date.js";
import { ID_DOCUMENT_TYPES, typeKey, typeKeySql } from "../clients/id-document-types.js";
import { branchZone } from "./branch-zone.js";

/* The sentence a teller or an owner sees. One wording, so a 422 from
   the route says the same thing every time. */
export const ID_STATUS_NOT_CLIENT_MESSAGE =
  "ID status is not taken from the request. A customer is Identified only when a current photo ID with an expiry date is on file.";

const STATUS_KEYS = new Set([
  "idstatus",
  "kycstatus",
  "verified",
  "idverified",
  "isverified",
  "identityverified",
  "kycverified",
]);

const STATUS_PARENTS = new Set(["kyc", "identity", "identification", "id"]);

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/**
 * True when the body, at any depth, names an ID standing or a verified
 * flag. The value does not matter. Sending missing is still the caller
 * deciding the standing.
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

export type IdStanding = {
  status: "identified" | "expired" | "missing";
  label: "Identified" | "Expired" | "Missing ID";
  detail: string;
  reason: string;
  tone: "ok" | "warning";
};

export type IdVerdict = "identified" | "expired" | "no_id";

const IDENTIFIED_REASON =
  "A current photo ID with a number and an expiry date is on file.";
const EXPIRED_REASON =
  "A photo ID on this file is past its expiry. The till will not treat this customer as identified.";
const MISSING_REASON = "A current photo ID is needed.";

function standing(verdict: IdVerdict): IdStanding {
  if (verdict === "identified") {
    return {
      status: "identified",
      label: "Identified",
      detail: IDENTIFIED_REASON,
      reason: IDENTIFIED_REASON,
      tone: "ok",
    };
  }
  if (verdict === "expired") {
    return {
      status: "expired",
      label: "Expired",
      detail: EXPIRED_REASON,
      reason: EXPIRED_REASON,
      tone: "warning",
    };
  }
  return {
    status: "missing",
    label: "Missing ID",
    detail: MISSING_REASON,
    reason: MISSING_REASON,
    tone: "warning",
  };
}

export function standingForVerdict(verdict: string): IdStanding {
  if (verdict === "identified" || verdict === "expired") return standing(verdict);
  return standing("no_id");
}

export function verdictToGate(verdict: string): DerivedIdStatus {
  if (verdict === "identified") return "verified";
  if (verdict === "expired") return "expired";
  return "missing";
}

/* Fail closed. A type counts only when the shared catalogue says it is
   a person photo ID, accepted as ID, and not a no-expiry type. A
   Citizenship Card may lack an expiry, so it does not count, even when
   this card has a date. A birth certificate is not in that list. */
function qualifyingTypeKeys(): string[] {
  const keys: string[] = [];
  for (const row of ID_DOCUMENT_TYPES) {
    if (row.kind !== "person" || !row.photo || !row.acceptedAsId || row.mayLackExpiry) continue;
    for (const name of [row.label, ...row.aliases]) {
      const key = typeKey(name);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function qualifyingJoinSql(): string {
  const rows = qualifyingTypeKeys().map((key, index) =>
    index === 0 ? `(${sqlText(key)}::text)` : `(${sqlText(key)})`,
  );
  return `LEFT JOIN (VALUES ${rows.join(", ")}) AS id_photo(name) ON id_photo.name = ${typeKeySql("d.doc_type")}`;
}

const NUMBER_PRESENT =
  "length(regexp_replace(coalesce(d.doc_number, ''), '[[:space:]]', '', 'g')) > 0";

/* Identified is one current photo ID with an expiry on or after the
   business date. A blank expiry does not qualify. An expired photo ID
   is Expired only when nothing current qualifies. The business date is
   a bound parameter. */
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
  const date = `${businessDateParam}::date`;
  const counted = (extra: string) =>
    `SELECT 1 FROM desk_client_identity_documents d
      ${qualifyingJoinSql()}
      WHERE ${where}
        AND id_photo.name IS NOT NULL
        AND ${NUMBER_PRESENT}
        AND (${extra})`;
  return `CASE
    WHEN EXISTS (${counted(`d.expires_on >= ${date}`)}) THEN 'identified'
    WHEN EXISTS (${counted(`d.expires_on < ${date}`)}) THEN 'expired'
    ELSE 'no_id'
  END`;
}

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

export async function branchBusinessDay(
  client: pg.PoolClient,
  branchId: string,
  at: Date = new Date(),
): Promise<string> {
  return civilTodayInZone(at, await branchZone(client, branchId));
}

export async function derivedIdVerdict(
  client: pg.PoolClient,
  customerId: string,
  tenantId: string,
  legalEntityId: string,
  branchId: string,
  at: Date = new Date(),
): Promise<IdVerdict> {
  const businessDate = await branchBusinessDay(client, branchId, at);
  const found = await client.query(
    `SELECT ${derivedIdVerdictSql("lc", "$4")} AS id_verdict
       FROM ledger_customers lc
      WHERE lc.customer_id = $1
        AND lc.tenant_id = $2
        AND lc.legal_entity_id = $3`,
    [customerId, tenantId, legalEntityId, businessDate],
  );
  const verdict = found.rows[0]?.id_verdict;
  if (verdict === "identified" || verdict === "expired") return verdict;
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
  return verdictToGate(
    await derivedIdVerdict(client, customerId, tenantId, legalEntityId, branchId, at),
  );
}
