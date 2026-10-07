/* The owner's download of this desk.
   Tenant and legal entity come from the signed-in session. The request
   cannot name another desk. Amounts stay the numeric text the database
   stored. Cheque clearing and cheque return rows are not deals. They
   are the same exclusion the ledger list already uses. */
import type pg from "pg";
import { SETTLEMENT_DEAL_KINDS_SQL } from "../ledger/cheques.js";
import { csvDocument, storedDecimal } from "./export-csv.js";

const CLIENT_HEADERS = [
  "client_id",
  "legal_name",
  "kind",
  "date_of_birth",
  "address",
  "city",
  "region",
  "postal_code",
  "country",
  "email",
  "phone",
  "occupation",
  "risk_rating",
  "verification_status",
  "primary_id_type",
  "primary_id_number",
  "primary_id_expires",
  "document_count",
];

const DEAL_HEADERS = [
  "transaction_ref",
  "posted_at",
  "branch_id",
  "till_id",
  "customer_name",
  "customer_id",
  "deal_kind",
  "from_currency",
  "input_amount",
  "to_currency",
  "output_amount",
  "rate",
  "fee_cad",
  "realized_pnl_home",
  "home_currency",
  "actor_id",
  "reversed",
  "reversal_reason",
];

const text = (value: unknown) => (value == null ? "" : String(value));
const code = (value: unknown) => text(value).trim();
const day = (value: unknown) => (value == null ? "" : String(value).slice(0, 10));

/* node-pg returns a Date for timestamptz. A text cast in the query
   returns a string. Anything else is not a timestamp this file knows
   how to print, and guessing would put a wrong time in the owner's file. */
export function postedAtIso(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("posted_at was not a timestamp.");
    return parsed.toISOString();
  }
  throw new Error("posted_at was not a timestamp.");
}

export async function clientsCsv(pool: pg.Pool, tenantId: string, legalEntityId: string): Promise<string> {
  const result = await pool.query(
    `SELECT c.client_id, c.display_name, c.kind, c.date_of_birth::text AS date_of_birth,
            c.address_line, c.city, c.region, c.postal_code, c.country, c.email, c.phone,
            c.occupation, c.risk_rating, c.verification_status,
            d.doc_type, d.doc_number, d.expires_on::text AS expires_on,
            (SELECT count(*)::int FROM desk_client_identity_documents x WHERE x.client_id = c.client_id) AS document_count
       FROM desk_clients c
       LEFT JOIN LATERAL (
         SELECT doc_type, doc_number, expires_on
           FROM desk_client_identity_documents
          WHERE client_id = c.client_id
          ORDER BY is_primary DESC, created_at
          LIMIT 1
       ) d ON true
      WHERE c.tenant_id = $1 AND c.legal_entity_id = $2
      ORDER BY c.display_name, c.client_id`,
    [tenantId, legalEntityId],
  );
  const rows = result.rows.map((row) => [
    text(row.client_id),
    text(row.display_name),
    text(row.kind),
    day(row.date_of_birth),
    text(row.address_line),
    text(row.city),
    text(row.region),
    text(row.postal_code),
    text(row.country),
    text(row.email),
    text(row.phone),
    text(row.occupation),
    text(row.risk_rating),
    text(row.verification_status),
    text(row.doc_type),
    text(row.doc_number),
    day(row.expires_on),
    text(row.document_count),
  ]);
  return csvDocument(CLIENT_HEADERS, rows);
}

export async function dealsCsv(pool: pg.Pool, tenantId: string, legalEntityId: string): Promise<string> {
  const result = await pool.query(
    `SELECT t.transaction_ref, t.posted_at, t.branch_id, t.till_id,
            c.name AS customer_name, t.customer_id, t.deal_kind,
            t.from_currency, t.input_amount, t.to_currency, t.output_amount, t.rate,
            t.fee_cad, t.realized_pnl_home, t.home_currency, t.actor_id,
            r.reversal_id, r.reason AS reversal_reason
       FROM ledger_transactions t
       JOIN ledger_customers c ON c.customer_id = t.customer_id
      LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
      WHERE t.tenant_id = $1 AND t.legal_entity_id = $2
        AND t.deal_kind NOT IN (${SETTLEMENT_DEAL_KINDS_SQL})
      ORDER BY t.posted_at, t.transaction_ref`,
    [tenantId, legalEntityId],
  );
  const rows = result.rows.map((row) => [
    text(row.transaction_ref),
    postedAtIso(row.posted_at),
    text(row.branch_id),
    text(row.till_id),
    text(row.customer_name),
    text(row.customer_id),
    text(row.deal_kind),
    code(row.from_currency),
    storedDecimal(row.input_amount),
    code(row.to_currency),
    storedDecimal(row.output_amount),
    storedDecimal(row.rate),
    storedDecimal(row.fee_cad),
    storedDecimal(row.realized_pnl_home),
    code(row.home_currency),
    text(row.actor_id),
    row.reversal_id ? "yes" : "no",
    text(row.reversal_reason),
  ]);
  return csvDocument(DEAL_HEADERS, rows);
}
