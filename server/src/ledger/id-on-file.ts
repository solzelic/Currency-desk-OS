import type pg from "pg";
import { civilTodayInZone } from "../civil-date.js";
import { ID_DOCUMENT_TYPES, typeKey, typeKeySql } from "../clients/id-document-types.js";
import { branchZone } from "./branch-zone.js";
export const ID_STATUS_NOT_CLIENT_MESSAGE =
  "ID status is not taken from the request. A customer is Identified only when a current photo ID with an expiry date is on file.";

const STATUS_KEYS = new Set([
  "idstatus", "kycstatus", "verified", "idverified", "isverified", "identityverified", "kycverified",
]);
const STATUS_PARENTS = new Set(["kyc", "identity", "identification", "id"]);

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, "").toLowerCase();
}

/** A body names an ID standing or a verified flag. The value does not matter. */

export function requestCarriesIdStatus(body: unknown, parent = ""): boolean {
  if (body == null || typeof body !== "object") return false;
  if (Array.isArray(body)) return body.some((item) => requestCarriesIdStatus(item, parent));
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const norm = normalizeKey(key);
    if (STATUS_KEYS.has(norm)) return true;
    const nested = STATUS_PARENTS.has(normalizeKey(parent))
      && (norm === "status" || norm === "outcome" || norm === "verified");
    if (nested) return true;
    if (value != null && typeof value === "object" && requestCarriesIdStatus(value, key)) return true;
  }
  return false;
}
export type DerivedIdStatus = "verified" | "expired" | "missing";
export type IdVerdict = "identified" | "expired" | "no_id";

export type IdStanding = {
  status: "identified" | "expired" | "missing";
  label: "Identified" | "Expired" | "Missing ID";
  detail: string;
  reason: string;
  tone: "ok" | "warning";
};

const REASONS = {
  identified: "A current photo ID with a number and an expiry date is on file.",
  expired: "A photo ID on this file is past its expiry. The till will not treat this customer as identified.",
  no_id: "A current photo ID is needed.",
} as const;

export function standingForVerdict(verdict: string): IdStanding {
  const key = verdict === "identified" || verdict === "expired" ? verdict : "no_id";
  const status = key === "no_id" ? "missing" : key;
  const label = key === "identified" ? "Identified" : key === "expired" ? "Expired" : "Missing ID";
  const tone = key === "identified" ? "ok" : "warning";
  return { status, label, detail: REASONS[key], reason: REASONS[key], tone };
}

export function verdictToGate(verdict: string): DerivedIdStatus {
  if (verdict === "identified") return "verified";
  if (verdict === "expired") return "expired";
  return "missing";
}

/* Fail closed. A type counts only when the shared catalogue says it is a person
   photo ID, accepted as ID, and not a no-expiry type. Citizenship Card may lack
   an expiry, so it does not count, even with a date. A birth certificate is not
   in that list. Identified needs a number and an expiry on or after the branch
   business date. A blank expiry does not qualify. Expired only when a qualifying
   photo ID is before that date and nothing current qualifies. */

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

function qualifyingJoinSql(): string {
  const rows = qualifyingTypeKeys().map((key) => `('${key.replace(/'/g, "''")}'::text)`);
  return `LEFT JOIN (VALUES ${rows.join(", ")}) AS id_photo(name) ON id_photo.name = ${typeKeySql("d.doc_type")}`;
}

const NUMBER_PRESENT =
  "length(regexp_replace(coalesce(d.doc_number, ''), '[[:space:]]', '', 'g')) > 0";

export function documentVerdictSql(
  clientIdExpr: string,
  tenantExpr: string,
  entityExpr: string,
  businessDateParam: string,
): string {
  const where =
    `d.client_id = ${clientIdExpr} AND d.tenant_id = ${tenantExpr} AND d.legal_entity_id = ${entityExpr}`;
  const date = `${businessDateParam}::date`;
  const counted = (extra: string) =>
    `SELECT 1 FROM desk_client_identity_documents d ${qualifyingJoinSql()} WHERE ${where} AND id_photo.name IS NOT NULL AND ${NUMBER_PRESENT} AND (${extra})`;
  return `CASE WHEN EXISTS (${counted(`d.expires_on >= ${date}`)}) THEN 'identified' WHEN EXISTS (${counted(`d.expires_on < ${date}`)}) THEN 'expired' ELSE 'no_id' END`;
}

export function derivedIdVerdictSql(alias: string, businessDateParam: string): string {
  return `CASE WHEN ${alias}.client_id IS NULL THEN 'no_id' ELSE ${documentVerdictSql(
    `${alias}.client_id`, `${alias}.tenant_id`, `${alias}.legal_entity_id`, businessDateParam,
  )} END`;
}

export async function branchBusinessDay(
  client: pg.PoolClient, branchId: string, at: Date = new Date(),
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
    `SELECT ${derivedIdVerdictSql("lc", "$4")} AS id_verdict FROM ledger_customers lc
      WHERE lc.customer_id = $1 AND lc.tenant_id = $2 AND lc.legal_entity_id = $3`,
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
  return verdictToGate(await derivedIdVerdict(
    client, customerId, tenantId, legalEntityId, branchId, at,
  ));
}
