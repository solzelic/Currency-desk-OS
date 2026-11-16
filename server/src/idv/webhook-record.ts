/* A terminal webhook fetches the inquiry, drops photos, and writes the
   record in the same transaction as the status change. The face crop,
   when the shop keeps one, is encrypted before that transaction. */
import type { Db } from "../db/index.js";
import { isHealthCardType } from "../clients/id-document-types.js";
import { encryptSecret } from "./id-number.js";
import { isSmallCrop } from "./face-crop.js";
import { readInquiryText } from "./inquiry-text.js";
import { cropFromFrontPhoto, fetchPersonaInquiry } from "./persona-calls.js";
import { personaApiKey } from "./providers/persona.js";
import { loadShopIdv, writePersonaRecord, dbQuery } from "./records.js";
import { shopEnvCodeFor } from "./shop-config.js";
import { locateIdvInquiry, markInquiry, recordIdvEvent } from "./store.js";
import { classifyCheck, type TierNumber } from "./tiers.js";
import type { IdvResult } from "./provider.js";

const RECORDABLE = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired", "review"]);

function statusWord(result: IdvResult): string {
  if (result.inquiryStatus) return result.inquiryStatus;
  if (result.outcome === "review") return "needs review";
  return result.outcome;
}

export async function finishIdvWebhook(
  db: Db,
  result: IdvResult,
  deps: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<"stored" | "duplicate" | "unknown" | "conflict"> {
  if (!RECORDABLE.has(result.outcome)) {
    const saved = await recordIdvEvent(db, result);
    if (saved === "stored") await markInquiry(db, result);
    return saved;
  }
  const located = await locateIdvInquiry(db, result);
  if (located === "unknown" || located === "conflict") return located;
  let prepared: Parameters<typeof writePersonaRecord>[1] | null = null;
  if (located.clientId) {
    const shop = await loadShopIdv(db, located.shopId);
    const shopCode = await shopEnvCodeFor(db, located.tenantId);
    const key = personaApiKey({ apiKeyRef: shop.apiKeyRef, shopCode }, deps.env);
    if (!key) throw new Error("inquiry_fetch_failed");
    const payload = await fetchPersonaInquiry({
      inquiryId: located.providerRef, key, env: deps.env, fetchImpl: deps.fetchImpl,
    });
    const text = readInquiryText(payload);
    const crop = shop.faceCrop
      ? await cropFromFrontPhoto({ url: text.frontPhotoUrl, key, env: deps.env, fetchImpl: deps.fetchImpl })
      : null;
    const safeCrop = crop && isSmallCrop(crop) ? crop : null;
    const number = text.identificationNumber && !isHealthCardType(text.idClass) ? text.identificationNumber : null;
    const tier: TierNumber = located.requestedTier === "4" ? "4" : "3";
    const classified = classifyCheck(result.outcome, text.selfieStatus);
    prepared = {
      tenantId: located.tenantId, legalEntityId: located.shopId, branchId: located.branchId,
      staffId: located.tellerId, clientId: located.clientId, tier, inquiryId: located.providerRef,
      textName: text.name, documentType: text.idClass, idClass: text.idClass, number,
      numberCipher: number ? await encryptSecret(number, deps.env) : null,
      cropCipher: safeCrop ? await encryptSecret(safeCrop.toString("base64"), deps.env) : null,
      jurisdiction: text.issuingSubdivision, country: text.issuingCountry,
      expiry: text.expirationDate, birth: text.birthdate, address: text.address,
      result: classified.result,
      providerChecks: `selfie ${text.selfieStatus ?? "missing"}`,
      governmentId: text.governmentIdVerificationId, selfieId: text.selfieVerificationId,
      templateId: text.templateId, templateVersion: text.templateVersion,
    };
  }
  const saved = await db.transaction(async (tx) => {
    const q = dbQuery(tx);
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
      [statusWord(result), result.provider, result.providerRef],
    );
    if (updated.rows.length && prepared) await writePersonaRecord(tx, prepared);
    return "stored" as const;
  });
  return saved;
}
