import type pg from "pg";
import { civilTodayInZone } from "../civil-date.js";
import { branchZone as branchZoneOnClient } from "./branch-zone.js";

/* Occupancy reads the branch clock on the pool, before its own
   query. It does not hold a transaction. A missing branches table
   falls back to America/Toronto. A post, an open, and a handover
   use the savepoint read in branch-zone.ts, on the connection
   they already hold. */
export async function branchZone(
  client: pg.Pool | pg.PoolClient,
  branchId: string,
): Promise<string> {
  let zone = "America/Toronto";
  try {
    const found = await client.query(
      "SELECT timezone FROM branches WHERE id = $1",
      [branchId],
    );
    const stored = String(found.rows[0]?.timezone ?? "").trim();
    if (stored) zone = stored;
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  return zone;
}

/* YYMMDD of that same day, for a CD- reference and an obligation
   reference. toISOString().slice(2, 10) is the UTC day. 00:04 in
   Asia/Jerusalem is still the previous UTC date, so a deal on 21 Oct
   was named CD-261020. The day uses branchZone from branch-zone.ts,
   on the connection the post already holds. */
export async function branchRefDay(
  client: pg.PoolClient,
  branchId: string,
  now: Date,
): Promise<string> {
  return civilTodayInZone(now, await branchZoneOnClient(client, branchId)).slice(2).replace(/-/g, "");
}
