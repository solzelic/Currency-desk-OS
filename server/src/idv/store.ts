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
  if (!row || row.provider_ref !== result.providerRef) return "unknown";
  const inserted = await db.execute(sql`
    INSERT INTO idv_events (event_id, provider, provider_ref, reference_id, shop_id, branch_id, teller_id, outcome)
    VALUES (${result.eventId}, ${result.provider}, ${row.provider_ref}, ${result.referenceId},
            ${row.shop_id}, ${row.branch_id}, ${row.teller_id}, ${result.outcome})
    ON CONFLICT (event_id) DO NOTHING RETURNING event_id
  `);
  return inserted.rows.length > 0 ? "stored" : "duplicate";
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
