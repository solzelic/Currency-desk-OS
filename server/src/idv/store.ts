/* Provider-neutral inquiry map. Shop, branch, and teller come from this table. */
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { ClientLookup, IdvResult } from "./provider.js";

export type IdvInquiry = {
  referenceId: string; shopId: string; branchId: string; tellerId: string; provider: string; providerRef: string;
  clientId?: string | null;
};

export async function insertIdvInquiry(db: Db, row: IdvInquiry): Promise<void> {
  await db.execute(sql`
    INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref, client_id)
    VALUES (${row.referenceId}, ${row.shopId}, ${row.branchId}, ${row.tellerId}, ${row.provider}, ${row.providerRef}, ${row.clientId ?? null})
  `);
}

export async function clientOnShop(
  db: Db, shopId: string, tenantId: string, clientId: string, clients?: ClientLookup,
): Promise<boolean> {
  if (clients) {
    const found = await clients.query(
      "SELECT 1 FROM desk_clients WHERE client_id = $1 AND legal_entity_id = $2 AND tenant_id = $3 LIMIT 1",
      [clientId, shopId, tenantId],
    );
    return (found.rowCount ?? 0) > 0;
  }
  const found = await db.execute(sql`
    SELECT 1 FROM desk_clients
     WHERE client_id = ${clientId} AND legal_entity_id = ${shopId} AND tenant_id = ${tenantId}
     LIMIT 1
  `);
  return found.rows.length > 0;
}

/* Latest check for this client. Status words only. No provider payload. */
export async function latestClientIdvStatus(db: Db, shopId: string, clientId: string): Promise<string | null> {
  const found = await db.execute(sql`
    SELECT status FROM idv_inquiries
     WHERE shop_id = ${shopId} AND client_id = ${clientId}
     ORDER BY created_at DESC, reference_id DESC
     LIMIT 1
  `);
  const status = (found.rows[0] as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : null;
}

type MapRow = {
  shop_id: string; branch_id: string; teller_id: string; provider_ref: string; reference_id: string; tenant_id: string;
};

/* unknown: this provider has no stored inquiry with that id.
   conflict: the event names a reference id that is not the stored one.
   duplicate: event id already stored.
   Shop and tenant come from the stored row, never the payload. */
export async function recordIdvEvent(db: Db, result: IdvResult): Promise<"stored" | "duplicate" | "unknown" | "conflict"> {
  const found = await db.execute(sql`
    SELECT i.shop_id, i.branch_id, i.teller_id, i.provider_ref, i.reference_id, e.tenant_id
      FROM idv_inquiries i
      JOIN legal_entities e ON e.id = i.shop_id
     WHERE i.provider = ${result.provider} AND i.provider_ref = ${result.providerRef}
     LIMIT 1
  `);
  const row = found.rows[0] as MapRow | undefined;
  if (!row || !row.tenant_id) return "unknown";
  const named = result.referenceId.trim();
  if (named && named !== row.reference_id) return "conflict";
  const inserted = await db.execute(sql`
    INSERT INTO idv_events (event_id, provider, provider_ref, reference_id, shop_id, branch_id, teller_id, outcome)
    VALUES (${result.eventId}, ${result.provider}, ${result.providerRef}, ${row.reference_id},
            ${row.shop_id}, ${row.branch_id}, ${row.teller_id}, ${result.outcome})
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id
  `);
  return inserted.rows.length > 0 ? "stored" : "duplicate";
}

const TERMINAL = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired"]);

/* created and started pass inquiryStatus. A final status is not replaced
   by an earlier one, so a finished check does not take a cap slot again. */
export async function markInquiry(db: Db, result: IdvResult): Promise<void> {
  const status = result.inquiryStatus ?? (TERMINAL.has(result.outcome) ? result.outcome : "");
  if (!status) return;
  await db.execute(sql`
    UPDATE idv_inquiries SET status = ${status}
     WHERE provider = ${result.provider} AND provider_ref = ${result.providerRef}
       AND status NOT IN ('approved', 'declined', 'failed', 'expired')
       AND NOT (status = 'needs review' AND ${status} = 'in progress')
  `);
}

export type ReservedInquiry =
  | { kind: "capped" }
  | { kind: "created"; referenceId: string; providerRef: string }
  | { kind: "reused"; referenceId: string; providerRef: string };

/* One open check per client. A second start reuses it, under the same lock as the cap. */
export async function reserveIdvSlot(db: Db, row: IdvInquiry, cap: number): Promise<ReservedInquiry> {
  const book = db as unknown as { transaction(fn: (tx: Db) => Promise<void>): Promise<void> };
  let reserved: ReservedInquiry = { kind: "capped" };
  await book.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.shopId}))`);
    if (row.clientId) {
      const open = await tx.execute(sql`
        SELECT reference_id, provider_ref FROM idv_inquiries
         WHERE shop_id = ${row.shopId} AND provider = ${row.provider} AND client_id = ${row.clientId}
           AND status IN ('starting', 'in progress', 'needs review')
         ORDER BY created_at DESC
         LIMIT 1
      `);
      const existing = open.rows[0] as { reference_id?: string; provider_ref?: string } | undefined;
      if (existing?.reference_id && existing.provider_ref) {
        reserved = { kind: "reused", referenceId: existing.reference_id, providerRef: existing.provider_ref };
        return;
      }
    }
    if (await countOpenInquiries(tx, row.shopId) >= cap) return;
    await insertIdvInquiry(tx, row);
    reserved = { kind: "created", referenceId: row.referenceId, providerRef: row.providerRef };
  });
  return reserved;
}

/* The ledger pool is shared. This wrapper refuses anything but a read. */
export function readOnlyClientLookup(pool: { query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }> }): ClientLookup {
  return {
    async query(text, values) {
      if (!/^\s*select\b/i.test(text)) throw new Error("read_only");
      const found = await pool.query(text, [...values]);
      return { rowCount: found.rowCount };
    },
  };
}

export async function countOpenInquiries(db: Db, shopId: string): Promise<number> {
  const found = await db.execute(sql`
    SELECT count(*)::int AS n FROM idv_inquiries
     WHERE shop_id = ${shopId} AND status IN ('starting', 'in progress', 'needs review')
  `);
  return Number((found.rows[0] as { n?: number | string } | undefined)?.n ?? 0);
}

export async function setProviderRef(db: Db, referenceId: string, providerRef: string): Promise<void> {
  await db.execute(sql`
    UPDATE idv_inquiries SET provider_ref = ${providerRef}
     WHERE reference_id = ${referenceId} AND provider_ref = ${referenceId}
  `);
}

export async function failStarting(db: Db, referenceId: string): Promise<void> {
  await db.execute(sql`
    UPDATE idv_inquiries SET status = 'failed'
     WHERE reference_id = ${referenceId} AND status = 'starting'
  `);
}

export async function listIdvEvents(db: Db, shopId: string) {
  const found = await db.execute(sql`
    SELECT event_id, reference_id, shop_id, provider_ref FROM idv_events
     WHERE shop_id = ${shopId} ORDER BY event_id
  `);
  return (found.rows as Array<{ event_id: string; reference_id: string; shop_id: string; provider_ref: string }>).map((row) => ({
    eventId: row.event_id, referenceId: row.reference_id, shopId: row.shop_id, providerRef: row.provider_ref,
  }));
}

export async function countIdvEvents(db: Db): Promise<number> {
  const found = await db.execute(sql`SELECT count(*)::int AS n FROM idv_events`);
  return Number((found.rows[0] as { n?: number | string } | undefined)?.n ?? 0);
}
