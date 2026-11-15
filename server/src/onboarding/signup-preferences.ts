import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { withSignupAccount } from "./signup-account.js";

/** An opt-out is effective even if the following payment request fails. */
export async function stopSignupCalls(db: Db, enquiryId: string): Promise<void> {
  await withSignupAccount(db, enquiryId, async (db, account) => {
    if (account.state !== "verified") return;
    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0];
    if (!row) throw new Error("signup_reservation_unavailable");
    const latest = (await db.select().from(schema.enquiryCallConsents).where(eq(schema.enquiryCallConsents.enquiryId, enquiryId)).orderBy(desc(schema.enquiryCallConsents.at)).limit(1))[0];
    if (latest?.event !== "stop") await db.insert(schema.enquiryCallConsents).values({
      id: randomUUID(), enquiryId, event: "stop", phone: typeof row.details?.phone === "string" ? row.details.phone : "",
    });
    await db.update(schema.enquiries).set({ samCallAt: null, details: { ...(row.details ?? {}), bestTime: "no call" } }).where(eq(schema.enquiries.id, enquiryId));
  });
}
