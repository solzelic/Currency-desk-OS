/* Didit webhook bookkeeping. The decision body is not stored and not
   logged. A repeat of the same session id and status is one event.
   Failed, abandoned, and declined scans are not billed. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { chargeForDiditOutcome } from "./providers/didit.js";
import type { IdvResult } from "./provider.js";
import { dbQuery, writePersonaRecord } from "./records.js";
import { locateIdvInquiry } from "./store.js";
import { classifyCheck, type CheckResult } from "./tiers.js";

const RECORDABLE = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired", "review"]);

function statusWord(result: IdvResult): string {
  if (result.inquiryStatus) return result.inquiryStatus;
  if (result.outcome === "review") return "needs review";
  return result.outcome;
}

function checkResult(result: IdvResult): CheckResult {
  const selfie = result.outcome === "approved" && result.checksPassed === true ? "approved" : null;
  return classifyCheck(result.outcome, selfie).result;
}

export async function finishDiditWebhook(
  db: Db,
  result: IdvResult,
): Promise<"stored" | "duplicate" | "unknown" | "conflict"> {
  /* No settle. Failed, abandoned, and declined stay no_charge.
     A pass is unbilled in this sandbox slice. */
  const charge = chargeForDiditOutcome(result.outcome);
  if (charge !== "no_charge" && charge !== "unbilled") throw new Error("didit_charge_unexpected");
  const located = await locateIdvInquiry(db, result);
  if (located === "unknown" || located === "conflict") return located;
  const next = statusWord(result);
  return db.transaction(async (tx) => {
    const q = dbQuery(tx);
    await q.query(
      "SELECT reference_id FROM idv_inquiries WHERE provider = $1 AND provider_ref = $2 FOR UPDATE",
      [result.provider, result.providerRef],
    );
    const inserted = await q.query(
      `INSERT INTO idv_events (event_id, provider, provider_ref, reference_id, shop_id, branch_id, teller_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [result.eventId, result.provider, result.providerRef, located.referenceId, located.shopId, located.branchId, located.tellerId, result.outcome],
    );
    if (!inserted.rows.length) return "duplicate" as const;
    const updated = await q.query(
      `UPDATE idv_inquiries SET status = $1
        WHERE provider = $2 AND provider_ref = $3
          AND status NOT IN ('approved', 'declined', 'failed', 'expired')
          AND NOT (status = 'needs review' AND $1 = 'in progress')
        RETURNING reference_id`,
      [next, result.provider, result.providerRef],
    );
    /* A later status that does not replace the stored one writes no check row. */
    if (updated.rows.length && RECORDABLE.has(result.outcome) && located.clientId) {
      const tier = located.requestedTier === "4" ? "4" : "3";
      await writePersonaRecord(tx, {
        recordId: `idc_${randomUUID()}`,
        tenantId: located.tenantId,
        legalEntityId: located.shopId,
        branchId: located.branchId,
        staffId: located.tellerId,
        clientId: located.clientId,
        tier,
        inquiryId: located.providerRef,
        textName: null,
        documentType: null,
        idClass: null,
        number: null,
        numberCipher: null,
        cropCipher: null,
        jurisdiction: null,
        country: null,
        expiry: null,
        birth: null,
        address: null,
        result: checkResult(result),
        providerChecks: result.checksLine ?? "ID not passed, liveness not passed, face match not passed",
        governmentId: null,
        selfieId: null,
        templateId: null,
        templateVersion: null,
        provider: "didit",
        method: "id_and_selfie",
        databaseStep: tier === "4" ? "off" : "not_applicable",
      });
    }
    return "stored" as const;
  });
}
