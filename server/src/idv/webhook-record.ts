/* A terminal webhook claims the event and saves the inquiry status before
   it fetches. A duplicate does not fetch. The face crop, when one is kept,
   is encrypted before the check row is written. A missing ID_NUMBER_KEY
   still stores the check, without the number or the crop. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { isHealthCardType } from "../clients/id-document-types.js";
import { encryptSecret, idNumberKey, KEY_VERSION, PURPOSE_CROP, PURPOSE_NUMBER } from "./id-number.js";
import { isSmallCrop } from "./face-crop.js";
import { readInquiryText } from "./inquiry-text.js";
import { cropFromFrontPhoto, fetchPersonaInquiry } from "./persona-calls.js";
import { personaApiKey } from "./providers/persona.js";
import { loadShopIdv, writePersonaRecord, dbQuery } from "./records.js";
import { shopEnvCodeFor } from "./shop-config.js";
import { locateIdvInquiry, markInquiry, recordIdvEvent } from "./store.js";
import { classifyCheck, isPastExpiry, type CheckResult, type TierNumber } from "./tiers.js";
import type { IdvResult } from "./provider.js";

const RECORDABLE = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired", "review"]);

function statusWord(result: IdvResult): string {
  if (result.inquiryStatus) return result.inquiryStatus;
  if (result.outcome === "review") return "needs review";
  return result.outcome;
}

function keyReady(env: NodeJS.ProcessEnv): boolean {
  try {
    idNumberKey(env);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === "id_number_key_unavailable") return false;
    throw err;
  }
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
  const claimed = await db.transaction(async (tx) => {
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
    return updated.rows.length ? "ready" as const : "stored" as const;
  });
  if (claimed !== "ready") return claimed === "duplicate" ? "duplicate" : "stored";
  if (!located.clientId) return "stored";
  const shop = await loadShopIdv(db, located.shopId);
  const shopCode = await shopEnvCodeFor(db, located.tenantId);
  const key = personaApiKey({ apiKeyRef: shop.apiKeyRef, shopCode }, deps.env);
  if (!key) throw new Error("inquiry_fetch_failed");
  const payload = await fetchPersonaInquiry({
    inquiryId: located.providerRef, key, env: deps.env, fetchImpl: deps.fetchImpl,
  });
  const text = readInquiryText(payload);
  const zoneRow = await dbQuery(db).query("SELECT timezone FROM branches WHERE id = $1", [located.branchId]);
  const zone = typeof zoneRow.rows[0]?.timezone === "string" && zoneRow.rows[0].timezone
    ? zoneRow.rows[0].timezone : "America/Toronto";
  let checkResult: CheckResult = classifyCheck(result.outcome, text.selfieStatus).result;
  if (checkResult === "pass" && isPastExpiry(text.expirationDate, zone)) checkResult = "expired";
  const number = text.identificationNumber && !isHealthCardType(text.idClass) ? text.identificationNumber : null;
  const shown = await dbQuery(db).query(
    `SELECT face_crop_shown FROM idv_consents
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND inquiry_id = $3
      ORDER BY recorded_at DESC LIMIT 1`,
    [located.tenantId, located.shopId, located.providerRef],
  );
  const consentShowed = shown.rows[0]?.face_crop_shown === true;
  const ready = keyReady(deps.env);
  if (!ready) console.warn("id number key unavailable");
  const keepCrop = ready && checkResult === "pass" && shop.faceCrop && consentShowed;
  const crop = keepCrop
    ? await cropFromFrontPhoto({ url: text.frontPhotoUrl, key, env: deps.env, fetchImpl: deps.fetchImpl })
    : null;
  const safeCrop = crop && isSmallCrop(crop) ? crop : null;
  const recordId = `idc_${randomUUID()}`;
  const tier: TierNumber = located.requestedTier === "4" ? "4" : "3";
  const numberCipher = ready && number
    ? await encryptSecret(number, {
      purpose: PURPOSE_NUMBER, tenantId: located.tenantId, recordId, keyVersion: KEY_VERSION,
    }, deps.env)
    : null;
  const cropCipher = ready && safeCrop
    ? await encryptSecret(safeCrop.toString("base64"), {
      purpose: PURPOSE_CROP, tenantId: located.tenantId, recordId, keyVersion: KEY_VERSION,
    }, deps.env)
    : null;
  await writePersonaRecord(db, {
    recordId,
    tenantId: located.tenantId, legalEntityId: located.shopId, branchId: located.branchId,
    staffId: located.tellerId, clientId: located.clientId, tier, inquiryId: located.providerRef,
    textName: text.name, documentType: text.idClass, idClass: text.idClass, number: ready ? number : null,
    numberCipher, cropCipher,
    jurisdiction: text.issuingSubdivision, country: text.issuingCountry,
    expiry: text.expirationDate, birth: text.birthdate, address: text.address,
    result: checkResult,
    providerChecks: `selfie ${text.selfieStatus ?? "missing"}`,
    governmentId: text.governmentIdVerificationId, selfieId: text.selfieVerificationId,
    templateId: text.templateId, templateVersion: text.templateVersion,
    numberUnavailable: !ready && Boolean(number),
  });
  return "stored";
}
