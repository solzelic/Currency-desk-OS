/* Provider-neutral inquiry map. Shop, branch, and teller come from this table. */
import { sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import type { IdvResult } from "./provider.js";

export type IdvInquiry = {
  referenceId: string; shopId: string; branchId: string; tellerId: string; provider: string; providerRef: string;
};

export async function insertIdvInquiry(db: Db, row: IdvInquiry): Promise<void> {
  await db.execute(sql`
    INSERT INTO idv_inquiries (reference_id, shop_id, branch_id, teller_id, provider, provider_ref)
    VALUES (${row.referenceId}, ${row.shopId}, ${row.branchId}, ${row.tellerId}, ${row.provider}, ${row.providerRef})
  `);
}

type MapRow = { shop_id: string; branch_id: string; teller_id: string; provider_ref: string };

/* unknown: reference is not on this provider's map. duplicate: event id already stored. */
export async function recordIdvEvent(db: Db, result: IdvResult): Promise<"stored" | "duplicate" | "unknown"> {
  const found = await db.execute(sql`
    SELECT shop_id, branch_id, teller_id, provider_ref FROM idv_inquiries
     WHERE provider = ${result.provider} AND reference_id = ${result.referenceId} LIMIT 1
  `);
  const row = found.rows[0] as MapRow | undefined;
  if (!row) return "unknown";
  /* The start route writes the reference id into provider_ref until Persona answers. */
  if (row.provider_ref !== result.providerRef) {
    if (row.provider_ref !== result.referenceId) return "unknown";
    const updated = await db.execute(sql`
      UPDATE idv_inquiries SET provider_ref = ${result.providerRef}
       WHERE reference_id = ${result.referenceId} AND provider = ${result.provider}
         AND provider_ref = ${result.referenceId}
      RETURNING provider_ref
    `);
    if (updated.rows.length === 0) return "unknown";
  }
  const inserted = await db.execute(sql`
    INSERT INTO idv_events (event_id, provider, provider_ref, reference_id, shop_id, branch_id, teller_id, outcome)
    VALUES (${result.eventId}, ${result.provider}, ${result.providerRef}, ${result.referenceId},
            ${row.shop_id}, ${row.branch_id}, ${row.teller_id}, ${result.outcome})
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id
  `);
  return inserted.rows.length > 0 ? "stored" : "duplicate";
}

const TERMINAL = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired"]);

/* created and started pass inquiryStatus. A terminal outcome frees the shop cap. */
export async function markInquiry(db: Db, result: IdvResult): Promise<void> {
  const status = result.inquiryStatus ?? (TERMINAL.has(result.outcome) ? result.outcome : "");
  if (!status) return;
  await db.execute(sql`UPDATE idv_inquiries SET status = ${status} WHERE reference_id = ${result.referenceId}`);
}

/* Count and insert share one transaction, so parallel starts cannot all pass the cap. */
export async function reserveIdvSlot(db: Db, row: IdvInquiry, cap: number): Promise<boolean> {
  const book = db as unknown as { transaction(fn: (tx: Db) => Promise<void>): Promise<void> };
  let reserved = false;
  await book.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.shopId}))`);
    if (await countOpenInquiries(tx, row.shopId) >= cap) return;
    await insertIdvInquiry(tx, row);
    reserved = true;
  });
  return reserved;
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
