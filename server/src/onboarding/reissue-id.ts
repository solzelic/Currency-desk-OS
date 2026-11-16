import { z } from "zod";
import { eq, isNull, and } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { issueCdId } from "../enquiries/cd-id.js";
import { sha256, withSignupAccount } from "./signup-account.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { idTail } from "./cd-id-door.js";

/** Keep authenticated ownership; retire the identifier and all pre-proof material. */
export async function reissueSignupId(db: Db, enquiryId: string, actorId: string) {
  return withSignupAccount(db, enquiryId, async (db, account) => {
    const row = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, enquiryId)).limit(1))[0];
    if (!row?.cdId || row.status === "accepted" || account.state === "active") return null;
    const details = row.details ?? {};
    const retired = z.array(z.string().regex(/^[a-f0-9]{64}$/)).parse(details.retiredCdIdHashes ?? []);
    const was = row.cdId;
    const cdId = await issueCdId(db, [typeof details.shopName === "string" ? details.shopName : "", typeof details.workspace === "string" ? details.workspace : "", row.name ?? ""]);
    await db.update(schema.enquiries).set({ cdId, details: { ...details, retiredCdIdHashes: [...retired, sha256(was)] } }).where(eq(schema.enquiries.id, enquiryId));
    await db.delete(schema.signupChallenges).where(eq(schema.signupChallenges.enquiryId, enquiryId));
    await db.delete(schema.signupCredentials).where(and(eq(schema.signupCredentials.enquiryId, enquiryId), isNull(schema.signupCredentials.verifiedAt)));
    await db.update(schema.signupAccounts).set({ codeHash: null, codeExpiresAt: null, codeAttempts: 0, updatedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, enquiryId));
    await audit(db, { tenantId: row.tenantId ?? PLATFORM_TENANT, legalEntityId: "-", branchId: "-", actorId,
      action: "cd_id.reissued", detail: { enquiryId, was: idTail(was), now: idTail(cdId) } });
    return { row, was, cdId };
  });
}
