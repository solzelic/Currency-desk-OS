/* Transfers are off for a real shop (CD-111, GitHub #599).

   Transfers (EFT) live only in each browser's local storage today. A
   wire with no server record is a wire nobody can report, so until
   transfer records are kept on the server (#597) a real shop cannot
   send or receive one. The server says so with 422
   TRANSFERS_NOT_AVAILABLE before anything is read or written; hiding
   the Transfers app alone would not do.

   A test shop keeps them: the staging demo and the staging door's shops
   (server/src/staging), and the shops of a test harness (markTestShop
   in seed.ts). The flag is tenants.is_test_shop (migration 056), read
   from the application database, which is the one the session came
   from: the ledger may live in another database (routes/desk.ts), so
   it cannot be read inside the ledger's own transaction.

   Switching Transfers on for real shops later needs the server records
   and the shop's FINTRAC registration listing money transferring; both
   are #597's. Nothing here deletes what a browser already holds. */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { LedgerError } from "./service.js";

export const TRANSFERS_OFF_MESSAGE =
  "Transfers are off for this shop until transfer records are kept on the server.";

/** Whether this shop may send or receive a transfer today. */
export async function transfersAvailable(db: Db, tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ isTestShop: schema.tenants.isTestShop })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  return rows[0]?.isTestShop === true;
}

/** Refuses a transfer for a real shop, as 422 TRANSFERS_NOT_AVAILABLE. */
export async function assertTransfersAvailable(db: Db, tenantId: string): Promise<void> {
  if (!(await transfersAvailable(db, tenantId))) {
    throw new LedgerError("TRANSFERS_NOT_AVAILABLE", TRANSFERS_OFF_MESSAGE);
  }
}
