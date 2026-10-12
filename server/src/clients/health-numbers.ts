/* A stored health number is not lawful to keep, and it was never valid ID.

   Two operations, neither of which runs on deploy:

   - healthCardReview: a read-only list, per shop, of clients who have a
     health card number stored and of posted deals that relied on one.
     The number itself is not in the list.
   - redactHealthNumbers: replaces that number with a marker, keeps the
     row, and writes an append-only audit entry. Dry-run is the default
     for the command that calls this. Passing apply: false changes nothing.
*/
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { isHealthCardType } from "./health-card.js";

export const REDACTED_HEALTH_NUMBER = "[redacted]";
export const REDACTION_ACTION = "client.health_number.redact";
const REDACTION_REASON =
  "number redacted for privacy. health number not lawful to keep, not valid ID";

export type RedactionActor = {
  userId: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  workspaceId: string;
};

type DocumentRow = {
  document_id: string;
  client_id: string;
  doc_type: string;
  doc_number: string | null;
  issuing_jurisdiction: string | null;
  expires_on: Date | string | null;
  is_primary: boolean;
  created_by: string | null;
  created_at: Date | string;
  legal_name: string;
};

type DealRow = {
  transaction_id: string;
  transaction_ref: string;
  posted_at: Date | string;
  client_id: string;
  legal_name: string;
  input_amount: string;
  from_currency: string;
};

const day = (value: Date | string | null) =>
  value == null ? null : new Date(value).toISOString().slice(0, 10);

const stored = (value: string | null) => (value ?? "").trim() !== "";
const redacted = (value: string | null) => (value ?? "").trim() === REDACTED_HEALTH_NUMBER;

function reliedOnHealthCard(documents: DocumentRow[]): boolean {
  const health = documents.filter((row) => isHealthCardType(row.doc_type) && stored(row.doc_number));
  if (!health.length) return false;
  const primary = documents.find((row) => row.is_primary);
  if (primary && isHealthCardType(primary.doc_type) && stored(primary.doc_number)) return true;
  return !documents.some((row) => stored(row.doc_number) && !isHealthCardType(row.doc_type));
}

async function documentsForShop(client: pg.PoolClient, tenantId: string, legalEntityId: string) {
  const result = await client.query<DocumentRow>(
    `SELECT d.document_id, d.client_id, d.doc_type, d.doc_number, d.issuing_jurisdiction,
            d.expires_on, d.is_primary, d.created_by, d.created_at, c.display_name AS legal_name
       FROM desk_client_identity_documents d
       JOIN desk_clients c ON c.client_id = d.client_id
      WHERE c.tenant_id = $1 AND c.legal_entity_id = $2
      ORDER BY c.display_name, d.created_at`,
    [tenantId, legalEntityId],
  );
  return result.rows;
}

function byClient(rows: DocumentRow[]) {
  const grouped = new Map<string, DocumentRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.client_id) ?? [];
    list.push(row);
    grouped.set(row.client_id, list);
  }
  return grouped;
}

/* Posted deals whose counterparty is one of these clients, and which
   have not been reversed. A reversal is a row in ledger_reversals. */
async function dealsFor(client: pg.PoolClient, tenantId: string, legalEntityId: string, clientIds: string[]) {
  if (!clientIds.length) return [];
  const result = await client.query<DealRow>(
    `SELECT t.transaction_id, t.transaction_ref, t.posted_at, lc.client_id,
            c.display_name AS legal_name, t.input_amount::text, t.from_currency
       FROM ledger_transactions t
       JOIN ledger_customers lc ON lc.customer_id = t.customer_id
       JOIN desk_clients c ON c.client_id = lc.client_id
       LEFT JOIN ledger_reversals r ON r.transaction_id = t.transaction_id
      WHERE t.tenant_id = $1 AND t.legal_entity_id = $2
        AND r.reversal_id IS NULL
        AND lc.client_id = ANY($3::text[])
      ORDER BY t.posted_at, t.transaction_ref`,
    [tenantId, legalEntityId, clientIds],
  );
  return result.rows;
}

export async function healthCardReview(pool: pg.Pool, tenantId: string, legalEntityId: string) {
  const client = await pool.connect();
  try {
    const rows = await documentsForShop(client, tenantId, legalEntityId);
    const grouped = byClient(rows);
    const clients = [];
    const reliedIds: string[] = [];
    for (const [clientId, documents] of grouped) {
      const health = documents.filter((row) => isHealthCardType(row.doc_type) && stored(row.doc_number));
      if (!health.length) continue;
      if (reliedOnHealthCard(documents)) reliedIds.push(clientId);
      clients.push({
        clientId,
        legalName: documents[0]!.legal_name,
        documents: health.map((row) => ({
          documentId: row.document_id,
          docType: row.doc_type,
          issuingJurisdiction: row.issuing_jurisdiction,
          expiresOn: day(row.expires_on),
          recordedAt: day(row.created_at),
          recordedBy: row.created_by,
          numberStatus: redacted(row.doc_number) ? "redacted" : "stored",
        })),
      });
    }
    const deals = (await dealsFor(client, tenantId, legalEntityId, reliedIds)).map((row) => ({
      transactionId: row.transaction_id,
      transactionRef: row.transaction_ref,
      postedAt: new Date(row.posted_at).toISOString(),
      clientId: row.client_id,
      legalName: row.legal_name,
      inputAmount: row.input_amount,
      fromCurrency: row.from_currency,
    }));
    return { tenantId, legalEntityId, clients, deals };
  } finally {
    client.release();
  }
}

export type RedactionCounts = {
  tenantId: string;
  legalEntityId: string;
  stored: number;
  alreadyRedacted: number;
  deals: number;
  redacted: number;
};

/* apply false rolls the transaction back. The counts are still returned.
   apply true writes the marker and one audit row per number. A row that
   is already the marker is skipped, so a second run writes nothing. */
export async function redactHealthNumbers(
  pool: pg.Pool,
  actor: RedactionActor,
  apply: boolean,
): Promise<RedactionCounts> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await documentsForShop(client, actor.tenantId, actor.legalEntityId);
    const grouped = byClient(rows);
    const health = rows.filter((row) => isHealthCardType(row.doc_type) && stored(row.doc_number));
    const pending = health.filter((row) => !redacted(row.doc_number));
    const reliedIds = [...grouped.entries()]
      .filter(([, documents]) => reliedOnHealthCard(documents))
      .map(([clientId]) => clientId);
    const deals = await dealsFor(client, actor.tenantId, actor.legalEntityId, reliedIds);
    let redactedCount = 0;
    if (apply) {
      for (const row of pending) {
        const updated = await client.query(
          `UPDATE desk_client_identity_documents
              SET doc_number = $2, updated_by = $3, updated_at = now()
            WHERE document_id = $1
              AND doc_number IS DISTINCT FROM $2
          RETURNING document_id`,
          [row.document_id, REDACTED_HEALTH_NUMBER, actor.userId],
        );
        if (updated.rowCount !== 1) {
          throw new Error(`Could not redact document ${row.document_id}. Nothing was committed.`);
        }
        await client.query(
          `INSERT INTO ledger_audit_events
            (event_id, tenant_id, legal_entity_id, branch_id, workspace_id, actor_id,
             action, target_id, reason, correlation_id, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())`,
          [
            randomUUID(),
            actor.tenantId,
            actor.legalEntityId,
            actor.branchId,
            actor.workspaceId,
            actor.userId,
            REDACTION_ACTION,
            row.document_id,
            `${row.client_id} · ${REDACTION_REASON}`,
            randomUUID(),
          ],
        );
        redactedCount += 1;
      }
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
    return {
      tenantId: actor.tenantId,
      legalEntityId: actor.legalEntityId,
      stored: pending.length - redactedCount,
      alreadyRedacted: health.length - pending.length + redactedCount,
      deals: deals.length,
      redacted: redactedCount,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("health-number redaction rollback failed", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveRedactionActor(pool: pg.Pool, staffKey: string): Promise<RedactionActor> {
  const found = await pool.query<{
    id: string;
    tenant_id: string;
    legal_entity_id: string;
    branch_id: string;
    role: string;
  }>(
    `SELECT id, tenant_id, legal_entity_id, branch_id, role
       FROM staff_users
      WHERE staff_id = $1 OR id = $1`,
    [staffKey],
  );
  if (found.rowCount === 0) throw new Error(`No staff user matches "${staffKey}".`);
  if ((found.rowCount ?? 0) > 1) {
    throw new Error(`"${staffKey}" matches more than one staff user. Pass the full user id.`);
  }
  const row = found.rows[0]!;
  if (row.role !== "administrator" && row.role !== "compliance_officer") {
    throw new Error("Only the owner or the compliance officer can redact a health number.");
  }
  const workspace = await pool.query<{ id: string }>(
    `SELECT id FROM workspaces
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND branch_id = $3
      ORDER BY id
      LIMIT 1`,
    [row.tenant_id, row.legal_entity_id, row.branch_id],
  );
  if (!workspace.rowCount) {
    throw new Error("That staff user has no workspace, so an audit row cannot name where this was run.");
  }
  return {
    userId: row.id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    workspaceId: workspace.rows[0]!.id,
  };
}
