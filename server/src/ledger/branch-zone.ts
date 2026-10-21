import type pg from "pg";

/* The clock a branch keeps. The process zone, and UTC, are not
   that clock. A missing branches table (a ledger database that
   does not hold the desk rows) falls back to the column's own
   default, America/Toronto.

   Call this on the transaction's own client. The caller is already
   inside a transaction: a savepoint is not legal outside one.
   A second checkout from the pool, while that transaction still
   holds a connection, waits forever once every connection is
   inside the same wait. The pool has no acquire timeout.

   A missing table aborts the surrounding transaction, and catching
   the error does not bring it back. The read sits on a savepoint,
   the same way the pack's rule lines do, so ROLLBACK TO that
   savepoint leaves the caller's transaction usable. */

export async function branchZone(
  client: pg.PoolClient,
  branchId: string,
): Promise<string> {
  await client.query("SAVEPOINT branch_zone");
  try {
    const found = await client.query(
      "SELECT timezone FROM branches WHERE id = $1",
      [branchId],
    );
    await client.query("RELEASE SAVEPOINT branch_zone");
    const stored = String(found.rows[0]?.timezone ?? "").trim();
    if (stored) return stored;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT branch_zone");
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
  return "America/Toronto";
}
