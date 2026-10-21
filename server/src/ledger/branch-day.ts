import type pg from "pg";
import { civilTodayInZone } from "../civil-date.js";

/* The clock the location keeps. The process zone, and UTC, are not
   that clock. A missing table (a ledger database that does not hold
   the desk rows) falls back to the column's own default. The read
   uses its own connection. Queried inside the till transaction, a
   missing table aborts that transaction, and catching the error
   does not bring it back. */
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
   was named CD-261020. */
export async function branchRefDay(
  pool: pg.Pool,
  branchId: string,
  now: Date,
): Promise<string> {
  return civilTodayInZone(now, await branchZone(pool, branchId)).slice(2).replace(/-/g, "");
}
