/* ID check records. Append-only. The document number and the face crop
   leave the database only through the reveal and the view, after the
   audit insert in the same transaction. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { normaliseForWrite, resolveIdType } from "../clients/id-document-types.js";
import { screenSubject } from "../screening/gate.js";
import { CONSENT_VERSION, DIDIT_CONSENT_VERSION, type ConsentFill } from "./consent-copy.js";
import { decryptSecret, encryptSecret, KEY_VERSION, last4, maskDocumentNumber, PURPOSE_CROP, PURPOSE_NUMBER, type SecretBind } from "./id-number.js";
import { isSmallCrop } from "./face-crop.js";
import { diditLiveAllowed } from "./providers/didit.js";
import { personaPassLabel } from "./providers/persona.js";
import { shopEnvCodeFor } from "./shop-config.js";
import type { ClientLookup } from "./provider.js";
import { clientOnShop } from "./store.js";
import {
  ADVISE_LINE, DETAIL_LINE, DUE_LINE, INCOMPLETE_LINE, METHOD_LABEL, NO_PHOTO_LINE, methodLabel,
  NONE_LINE, PROGRESS_LINE, REVIEW_LINE, DECLINED_LINE, HAND_TYPED_LINE, TOO_OLD_LINE,
  branchStamp, civilDateWords, expiredLine, expiredNextDealLine, idCheckedLine, notPassedLine, seenInPersonLine, underReviewLine,
  verifiedScanChip,
  isPastExpiry, returningLine, tierMethod, type CheckMethod, type CheckResult, type TierNumber,
} from "./tiers.js";

type Row = Record<string, unknown>;
type Q = { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }> };

export type DeskActor = {
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  staffId: string;
  role: string;
  userId: string;
};

export type Step<T> = { ok: true; body: T } | { ok: false; status: number; error: string; message: string };

const fail = (status: number, error: string, message: string): Step<never> => ({ ok: false, status, error, message });

export const REVEAL_ROLES = new Set(["supervisor", "branch_manager", "compliance_officer", "administrator"]);
/* Tellers compare the crop by eye. Auditors do not. The number stays with the roles above. */
export const CROP_ROLES = new Set(["teller", "supervisor", "branch_manager", "compliance_officer", "administrator"]);
export const REVEAL_REASONS = new Set(["fintrac_request", "report_filing", "id_mismatch", "client_request"]);
export const CROP_REASON = "eye_comparison";

export function dbQuery(db: Db): Q {
  return (db as unknown as { session: { client: Q } }).session.client;
}

function str(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* A DATE column comes back as local midnight. Reading the UTC fields
   prints the previous calendar day anywhere east of UTC. */
export function day(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const date = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${date}`;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  return value.slice(0, 10);
}

async function inquiryForClient(q: Q, actor: DeskActor, inquiryId: string, clientId: string): Promise<boolean> {
  const found = await q.query(
    `SELECT 1
       FROM idv_inquiries i
       JOIN legal_entities e ON e.id = i.shop_id
      WHERE (i.provider_ref = $1 OR i.reference_id = $1)
        AND i.client_id = $2
        AND i.shop_id = $3
        AND e.tenant_id = $4
      LIMIT 1`,
    [inquiryId, clientId, actor.legalEntityId, actor.tenantId],
  );
  return found.rows.length > 0;
}

export async function inquiryClientId(db: Db, actor: DeskActor, inquiryId: string): Promise<string | null> {
  const found = await dbQuery(db).query(
    `SELECT i.client_id
       FROM idv_inquiries i
       JOIN legal_entities e ON e.id = i.shop_id
      WHERE (i.provider_ref = $1 OR i.reference_id = $1)
        AND i.shop_id = $2
        AND e.tenant_id = $3
        AND i.client_id IS NOT NULL
      LIMIT 1`,
    [inquiryId, actor.legalEntityId, actor.tenantId],
  );
  const id = found.rows[0]?.client_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function clientOwned(q: Q, actor: DeskActor, clientId: string): Promise<boolean> {
  const found = await q.query(
    "SELECT 1 FROM desk_clients WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3",
    [clientId, actor.tenantId, actor.legalEntityId],
  );
  return found.rows.length > 0;
}

export type ShopIdv = {
  provider: string;
  faceCrop: boolean;
  apiKeyRef: string | null;
  templateId: string | null;
  templateIdTier3: string | null;
  templateIdTier4: string | null;
  checksEnabled: boolean;
  privacyContact: string | null;
  privacyEmail: string | null;
  privacyPhone: string | null;
  privacyPolicyUrl: string | null;
};

export async function loadShopIdv(db: Db, shopId: string): Promise<ShopIdv> {
  const found = await dbQuery(db).query(
    `SELECT provider, face_crop_enabled, api_key_ref, template_id, template_id_tier3, template_id_tier4,
            checks_enabled, privacy_contact, privacy_email, privacy_phone, privacy_policy_url
       FROM idv_shop_config WHERE shop_id = $1`,
    [shopId],
  );
  const row = found.rows[0];
  if (!row) {
    return {
      provider: "persona",
      faceCrop: true, apiKeyRef: null, templateId: null, templateIdTier3: null, templateIdTier4: null,
      checksEnabled: false, privacyContact: null, privacyEmail: null, privacyPhone: null, privacyPolicyUrl: null,
    };
  }
  return {
    provider: str(row, "provider") ?? "persona",
    faceCrop: row.face_crop_enabled !== false,
    apiKeyRef: str(row, "api_key_ref"),
    templateId: str(row, "template_id"),
    templateIdTier3: str(row, "template_id_tier3"),
    templateIdTier4: str(row, "template_id_tier4"),
    checksEnabled: row.checks_enabled === true,
    privacyContact: str(row, "privacy_contact"),
    privacyEmail: str(row, "privacy_email"),
    privacyPhone: str(row, "privacy_phone"),
    privacyPolicyUrl: str(row, "privacy_policy_url"),
  };
}

export function templateForTier(shop: ShopIdv, tier: TierNumber | null): string | null {
  if (tier === "4") return shop.templateIdTier4 || shop.templateIdTier3 || shop.templateId;
  if (tier === "3") return shop.templateIdTier3 || shop.templateId;
  return shop.templateId;
}

async function branchFacts(q: Q, actor: DeskActor): Promise<{ province: string | null; timeZone: string }> {
  const found = await q.query(
    "SELECT province, timezone FROM branches WHERE id = $1 AND legal_entity_id = $2",
    [actor.branchId, actor.legalEntityId],
  );
  const row = found.rows[0];
  return { province: row ? str(row, "province") : null, timeZone: row ? str(row, "timezone") ?? "America/Toronto" : "America/Toronto" };
}

async function legalName(q: Q, shopId: string): Promise<string | null> {
  const found = await q.query("SELECT name FROM legal_entities WHERE id = $1", [shopId]);
  return found.rows[0] ? str(found.rows[0], "name") : null;
}

export async function consentFill(db: Db, actor: DeskActor): Promise<ConsentFill> {
  const q = dbQuery(db);
  const shop = await loadShopIdv(db, actor.legalEntityId);
  return {
    legalName: await legalName(q, actor.legalEntityId),
    privacyContact: shop.privacyContact,
    privacyEmail: shop.privacyEmail,
    privacyPhone: shop.privacyPhone,
    privacyPolicyUrl: shop.privacyPolicyUrl,
    personaNoticeUrl: "https://withpersona.com/legal/privacy-policy",
    faceCrop: shop.faceCrop,
  };
}

async function linkDeal(q: Q, actor: DeskActor, recordId: string, clientId: string, dealId: string | null): Promise<void> {
  if (!dealId) return;
  await q.query(
    `INSERT INTO idv_check_deals (link_id, record_id, deal_id, tenant_id, legal_entity_id, client_id, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [`deal_${randomUUID()}`, recordId, dealId, actor.tenantId, actor.legalEntityId, clientId, actor.staffId],
  );
}

type InsertRecord = {
  tier: TierNumber;
  method: CheckMethod;
  result: CheckResult;
  nameOnId?: string | null;
  documentType?: string | null;
  personaIdClass?: string | null;
  numberCipher?: string | null;
  numberLast4?: string | null;
  issuingJurisdiction?: string | null;
  issuingCountry?: string | null;
  expiryDate?: string | null;
  providerChecks?: string | null;
  personaInquiryId?: string | null;
  governmentIdVerificationId?: string | null;
  selfieVerificationId?: string | null;
  templateId?: string | null;
  templateVersion?: string | null;
  inspectorStaffId?: string | null;
  attestation?: string | null;
  confirmedBy?: string | null;
  originalRecordId?: string | null;
  consentId?: string | null;
  counterCheck?: boolean;
  dealId?: string | null;
  addressLine?: string | null;
  dateOfBirth?: string | null;
  databaseStep?: "off" | "not_applicable";
  cropCipher?: string | null;
  verifiedAt?: string | null;
  recordId?: string;
  numberUnavailable?: boolean;
  provider?: "persona" | "didit";
};

async function insertRecord(q: Q, actor: DeskActor, clientId: string, row: InsertRecord): Promise<string> {
  const id = row.recordId ?? `idc_${randomUUID()}`;
  const plan = tierMethod(row.tier);
  await q.query(
    `INSERT INTO idv_check_records (
      record_id, tenant_id, legal_entity_id, branch_id, client_id, tier, method, name_on_id,
      document_type, persona_id_class, document_number_ciphertext, document_number_last4,
      issuing_jurisdiction, issuing_country, expiry_date, result, provider_checks,
      persona_inquiry_id, government_id_verification_id, selfie_verification_id,
      template_id, template_version, staff_id, inspector_staff_id, attestation,
      confirmed_by_staff_id, original_record_id, consent_id, counter_check_chosen, deal_id,
      address_line, date_of_birth, database_step, face_crop_ciphertext, face_crop_retained_until, verified_at,
      key_version, retain_until, number_unavailable, provider
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,
      CASE WHEN $34::text IS NULL THEN NULL ELSE now() + interval '5 years' END,
      COALESCE($35::timestamptz, now()),
      ${KEY_VERSION},
      COALESCE($35::timestamptz, now()) + interval '5 years',
      $36,
      COALESCE($37, 'persona')
    )`,
    [
      id, actor.tenantId, actor.legalEntityId, actor.branchId, clientId, row.tier, row.method,
      row.nameOnId ?? null, row.documentType ?? null, row.personaIdClass ?? null,
      row.numberCipher ?? null, row.numberLast4 ?? null, row.issuingJurisdiction ?? null, row.issuingCountry ?? null,
      row.expiryDate ?? null, row.result, row.providerChecks ?? null, row.personaInquiryId ?? null,
      row.governmentIdVerificationId ?? null, row.selfieVerificationId ?? null, row.templateId ?? null,
      row.templateVersion ?? null, actor.staffId, row.inspectorStaffId ?? null, row.attestation ?? null,
      row.confirmedBy ?? null, row.originalRecordId ?? null, row.consentId ?? null, row.counterCheck === true,
      row.dealId ?? null, row.addressLine ?? null, row.dateOfBirth ?? null,
      row.databaseStep ?? plan.databaseStep, row.cropCipher ?? null, row.verifiedAt ?? null,
      row.numberUnavailable === true,
      row.provider ?? null,
    ],
  );
  await linkDeal(q, actor, id, clientId, row.dealId ?? null);
  return id;
}

export async function storeConsent(db: Db, actor: DeskActor, input: {
  clientId: string; choice: "agreed" | "counter_check"; language: string; inquiryId: string | null;
  copyVersion: string; faceCropShown: boolean;
}): Promise<Step<{ consentId: string; choice: string; tellerLine: string | null; persona: boolean }>> {
  const q = dbQuery(db);
  if (!await clientOwned(q, actor, input.clientId)) return fail(404, "not_found", "That client is not on this shop.");
  if (input.inquiryId && !await inquiryForClient(q, actor, input.inquiryId, input.clientId)) {
    return fail(404, "not_found", "That ID check is not on this client.");
  }
  const language = input.language.trim().toLowerCase();
  if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language)) return fail(400, "invalid_request", "The consent language is not valid.");
  const shop = await loadShopIdv(db, actor.legalEntityId);
  const versionOk = shop.provider === "didit"
    ? input.copyVersion === DIDIT_CONSENT_VERSION
    : input.copyVersion === CONSENT_VERSION;
  if (!versionOk || input.faceCropShown !== shop.faceCrop) {
    return fail(409, "consent_copy_changed", "The notice changed. Read it again before you choose.");
  }
  const id = `cns_${randomUUID()}`;
  await q.query(
    `INSERT INTO idv_consents
      (consent_id, tenant_id, legal_entity_id, branch_id, client_id, copy_version, language, inquiry_id, choice, staff_id, face_crop_shown)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, actor.tenantId, actor.legalEntityId, actor.branchId, input.clientId, input.copyVersion,
      language, input.inquiryId, input.choice, actor.staffId, input.faceCropShown,
    ],
  );
  const counter = input.choice === "counter_check";
  return {
    ok: true,
    body: {
      consentId: id,
      choice: input.choice,
      tellerLine: counter ? "Customer chose the counter check. Inspect the original ID." : null,
      persona: !counter,
    },
  };
}

export async function agreedConsent(db: Db, actor: DeskActor, inquiryId: string): Promise<boolean> {
  const found = await dbQuery(db).query(
    `SELECT 1
       FROM idv_consents c
       JOIN idv_inquiries i
         ON (i.provider_ref = c.inquiry_id OR i.reference_id = c.inquiry_id)
        AND i.client_id = c.client_id
        AND i.shop_id = c.legal_entity_id
       JOIN legal_entities e ON e.id = i.shop_id AND e.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.legal_entity_id = $2 AND c.inquiry_id = $3 AND c.choice = 'agreed'
      LIMIT 1`,
    [actor.tenantId, actor.legalEntityId, inquiryId],
  );
  return found.rows.length > 0;
}

export async function recordInPerson(db: Db, actor: DeskActor, input: {
  clientId: string; nameOnId: string; documentType: string; documentNumber: string;
  issuingJurisdiction: string; issuingCountry: string; expiryDate?: string | null;
  attested: boolean; dealId?: string | null; address?: string | null; dateOfBirth?: string | null;
  consentId?: string | null;
}, env: NodeJS.ProcessEnv): Promise<Step<{ recordId: string; maskedNumber: string; photoLine: string }>> {
  const q = dbQuery(db);
  if (!await clientOwned(q, actor, input.clientId)) return fail(404, "not_found", "That client is not on this shop.");
  if (input.attested !== true) return fail(400, "attestation_required", "The staff member has to attest that they inspected the original ID.");
  const typed = normaliseForWrite(input.documentType);
  if (!typed.ok) return fail(422, typed.code, typed.detail);
  const number = input.documentNumber.trim();
  if (number.length < 4 || number.length > 40) return fail(400, "invalid_request", "Enter the document number.");
  const name = input.nameOnId.trim();
  const jurisdiction = input.issuingJurisdiction.trim();
  const country = input.issuingCountry.trim();
  if (!name || !jurisdiction || !country) return fail(400, "invalid_request", "Name, issuer, and country are required.");
  const expiry = input.expiryDate ? day(input.expiryDate) : null;
  if (input.expiryDate && !expiry) return fail(400, "invalid_request", "The expiry date is not valid.");
  const birth = input.dateOfBirth ? day(input.dateOfBirth) : null;
  if (input.dateOfBirth && !birth) return fail(400, "invalid_request", "The date of birth is not valid.");
  let counterFromConsent = false;
  if (input.consentId) {
    const consent = await q.query(
      `SELECT inquiry_id, choice FROM idv_consents
        WHERE consent_id = $1 AND tenant_id = $2 AND legal_entity_id = $3 AND client_id = $4`,
      [input.consentId, actor.tenantId, actor.legalEntityId, input.clientId],
    );
    const consentRow = consent.rows[0];
    const inquiryOnConsent = consentRow ? str(consentRow, "inquiry_id") : null;
    if (!consentRow || consentRow.choice !== "counter_check") {
      return fail(404, "not_found", "That consent is not on this client.");
    }
    if (inquiryOnConsent && !await inquiryForClient(q, actor, inquiryOnConsent, input.clientId)) {
      return fail(404, "not_found", "That ID check is not on this client.");
    }
    counterFromConsent = true;
  }
  const facts = await branchFacts(q, actor);
  const expired = expiry ? isPastExpiry(expiry, facts.timeZone) : false;
  const recordId = `idc_${randomUUID()}`;
  let cipher: string;
  try {
    cipher = await encryptSecret(number, { purpose: PURPOSE_NUMBER, tenantId: actor.tenantId, recordId, keyVersion: KEY_VERSION }, env);
  } catch (err) {
    if (err instanceof Error && err.message === "id_number_key_unavailable") {
      return fail(503, "id_number_key_unavailable", "ID number storage is not set up for this shop yet.");
    }
    throw err;
  }
  const id = await insertRecord(q, actor, input.clientId, {
    recordId,
    tier: "1", method: "in_person", result: expired ? "expired" : "pass", nameOnId: name, documentType: typed.label,
    numberCipher: cipher, numberLast4: last4(number), issuingJurisdiction: jurisdiction, issuingCountry: country,
    expiryDate: expiry, inspectorStaffId: actor.staffId,
    attestation: expired ? null : "Inspected the original ID. It looked authentic, valid, and not expired, and the face matched.",
    dealId: input.dealId ?? null, addressLine: input.address?.trim() || null, dateOfBirth: birth,
    consentId: counterFromConsent ? input.consentId ?? null : null, counterCheck: counterFromConsent,
    databaseStep: "not_applicable",
  });
  return { ok: true, body: { recordId: id, maskedNumber: maskDocumentNumber(number), photoLine: NO_PHOTO_LINE } };
}

type FullCheck = {
  record_id: string; verified_at: Date | string; method: CheckMethod; due: boolean; advise: boolean;
  face_crop_ciphertext: string | null;
};

async function latestFullCheck(q: Q, actor: DeskActor, clientId: string): Promise<FullCheck | null> {
  const found = await q.query(
    `SELECT record_id, verified_at, method,
            CASE WHEN face_crop_retained_until > now() THEN face_crop_ciphertext ELSE NULL END AS face_crop_ciphertext,
            verified_at <= now() - interval '5 years' AS due,
            verified_at <= now() - interval '3 years' AS advise
       FROM idv_check_records r
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND client_id = $3
        AND result = 'pass'
        AND method IN ('in_person', 'id_and_selfie', 'id_selfie_database')
        AND NOT EXISTS (
          SELECT 1 FROM idv_record_supersessions s
           WHERE s.record_id = r.record_id AND s.tenant_id = r.tenant_id AND s.legal_entity_id = r.legal_entity_id
        )
      ORDER BY verified_at DESC
      LIMIT 1`,
    [actor.tenantId, actor.legalEntityId, clientId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    record_id: String(row.record_id),
    verified_at: row.verified_at as Date | string,
    method: String(row.method) as CheckMethod,
    due: row.due === true,
    advise: row.advise === true,
    face_crop_ciphertext: str(row, "face_crop_ciphertext"),
  };
}

export async function recordReturning(db: Db, actor: DeskActor, input: {
  clientId: string; noDoubts: boolean; detailsChanged: boolean; doubtReason?: string | null;
  dealId?: string | null; pepAnswer: "yes" | "no" | "not_asked";
}): Promise<Step<Record<string, unknown>>> {
  if (input.pepAnswer !== "yes" && input.pepAnswer !== "no" && input.pepAnswer !== "not_asked") {
    return fail(400, "pep_answer_required", "Ask the client whether they are a politically exposed person, and record the answer.");
  }
  return db.transaction(async (tx) => {
    const q = dbQuery(tx);
    if (!await clientOwned(q, actor, input.clientId)) return fail(404, "not_found", "That client is not on this shop.");
    const shop = await loadShopIdv(tx, actor.legalEntityId);
    const earlier = await latestFullCheck(q, actor, input.clientId);
    if (!earlier) return fail(409, "no_earlier_check", "Returning client needs an earlier ID check at this shop.");
    if (earlier.due) return fail(409, "full_check_due", DUE_LINE);
    if (input.detailsChanged) {
      await q.query(
        `INSERT INTO idv_returning_blocks (block_id, tenant_id, legal_entity_id, client_id, staff_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [`blk_${randomUUID()}`, actor.tenantId, actor.legalEntityId, input.clientId, actor.staffId, "identifying details changed"],
      );
      return fail(409, "details_changed", "Identifying details have changed. A new full ID check is needed.");
    }
    if (input.noDoubts !== true) {
      const reason = input.doubtReason?.trim() || "doubt";
      await q.query(
        `INSERT INTO idv_returning_blocks (block_id, tenant_id, legal_entity_id, client_id, staff_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [`blk_${randomUUID()}`, actor.tenantId, actor.legalEntityId, input.clientId, actor.staffId, reason.slice(0, 500)],
      );
      return fail(409, "doubt", "A doubt blocks the returning client check for this visit.");
    }
    const owned = await q.query(
      "SELECT display_name, date_of_birth FROM desk_clients WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3",
      [input.clientId, actor.tenantId, actor.legalEntityId],
    );
    const client = owned.rows[0];
    if (!client) return fail(404, "not_found", "That client is not on this shop.");
    const answerId = `pep_${randomUUID()}`;
    await q.query(
      `INSERT INTO client_pep_answer_events
        (answer_id, client_id, tenant_id, legal_entity_id, answer, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [answerId, input.clientId, actor.tenantId, actor.legalEntityId, input.pepAnswer, actor.staffId],
    );
    if (input.pepAnswer === "yes") {
      await q.query(
        `INSERT INTO client_pep_reviews
          (review_id, client_id, tenant_id, legal_entity_id, answer_id, status)
         VALUES ($1,$2,$3,$4,$5,'open')`,
        [`prv_${randomUUID()}`, input.clientId, actor.tenantId, actor.legalEntityId, answerId],
      );
    }
    const plan = await screenSubject(q, {
      tenantId: actor.tenantId, legalEntityId: actor.legalEntityId, userId: actor.staffId,
    }, {
      name: String(client.display_name),
      dob: client.date_of_birth ? String(client.date_of_birth).slice(0, 10) : null,
      clientId: input.clientId,
    });
    /* A PEP Yes is a compliance review. It does not hold this check or the deal.
       Only the sanctions plan holds the returning result. */
    const result: CheckResult = plan.hold ? "needs_review" : "returning_confirmed";
    const photoOnFile = shop.faceCrop && Boolean(earlier.face_crop_ciphertext);
    const id = await insertRecord(q, actor, input.clientId, {
      tier: "2", method: "returning_client", result, confirmedBy: actor.staffId,
      originalRecordId: earlier.record_id, dealId: input.dealId ?? null, databaseStep: "not_applicable",
      providerChecks: plan.outcome,
    });
    const screening = plan.hold
      ? { state: "needs_review", message: REVIEW_LINE }
      : { state: plan.outcome === "not_screened" ? "not_screened" : "clear" };
    return {
      ok: true,
      body: {
        recordId: id,
        tier: "2",
        result,
        originalRecordId: earlier.record_id,
        advice: earlier.advise && !earlier.due ? ADVISE_LINE : null,
        photoOnFile,
        photoLine: photoOnFile ? null : NO_PHOTO_LINE,
        screened: true,
        screening,
        persona: false,
      },
    };
  });
}

export async function writePersonaRecord(db: Db, input: {
  recordId: string;
  tenantId: string; legalEntityId: string; branchId: string; staffId: string; clientId: string;
  tier: TierNumber; inquiryId: string; textName: string | null; documentType: string | null;
  idClass: string | null; number: string | null; numberCipher: string | null; cropCipher: string | null;
  jurisdiction: string | null; country: string | null;
  expiry: string | null; birth: string | null; address: string | null; result: CheckResult;
  providerChecks: string | null; governmentId: string | null; selfieId: string | null;
  templateId: string | null; templateVersion: string | null;
  numberUnavailable?: boolean;
  provider?: "persona" | "didit";
  method?: CheckMethod;
  databaseStep?: "off" | "not_applicable";
}): Promise<void> {
  const plan = tierMethod(input.tier === "4" ? "4" : "3");
  const actor: DeskActor = {
    tenantId: input.tenantId, legalEntityId: input.legalEntityId, branchId: input.branchId,
    staffId: input.staffId, role: "teller", userId: input.staffId,
  };
  await insertRecord(dbQuery(db), actor, input.clientId, {
    recordId: input.recordId,
    tier: input.tier === "4" ? "4" : "3",
    method: input.method ?? "id_and_selfie",
    result: input.result,
    nameOnId: input.textName,
    documentType: input.documentType,
    personaIdClass: input.idClass,
    numberCipher: input.numberCipher,
    numberLast4: input.number ? last4(input.number) : null,
    issuingJurisdiction: input.jurisdiction,
    issuingCountry: input.country,
    expiryDate: day(input.expiry),
    dateOfBirth: day(input.birth),
    addressLine: input.address,
    providerChecks: input.providerChecks,
    personaInquiryId: input.inquiryId,
    governmentIdVerificationId: input.governmentId,
    selfieVerificationId: input.selfieId,
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    databaseStep: input.databaseStep ?? (input.tier === "4" ? "off" : plan.databaseStep),
    provider: input.provider ?? "persona",
    cropCipher: input.cropCipher,
    numberUnavailable: input.numberUnavailable === true,
  });
}

async function testLabel(db: Db, actor: DeskActor, env: NodeJS.ProcessEnv): Promise<boolean> {
  const shop = await loadShopIdv(db, actor.legalEntityId);
  const code = await shopEnvCodeFor(db, actor.tenantId);
  return personaPassLabel(env, shop.apiKeyRef, code) === "Check passed (test)";
}

export async function readClientChecks(db: Db, actor: DeskActor, clientId: string, env: NodeJS.ProcessEnv, clients?: ClientLookup) {
  const q = dbQuery(db);
  /* Client files can live on the ledger connection. A missing check is an empty list, not a 404. */
  if (!await clientOnShop(db, actor.legalEntityId, actor.tenantId, clientId, clients)) {
    return fail(404, "not_found", "That client is not on this shop.");
  }
  const shop = await loadShopIdv(db, actor.legalEntityId);
  const facts = await branchFacts(q, actor);
  const test = await testLabel(db, actor, env);
  const found = await q.query(
    `SELECT r.record_id, r.tier, r.method, r.name_on_id, r.verified_at, r.document_type, r.persona_id_class,
            r.document_number_last4, (r.document_number_ciphertext IS NOT NULL) AS number_stored,
            r.number_unavailable, r.issuing_jurisdiction, r.issuing_country, r.expiry_date, r.result,
            r.provider_checks, r.persona_inquiry_id, r.staff_id, r.inspector_staff_id, r.original_record_id, r.consent_id,
            r.counter_check_chosen, r.deal_id, r.database_step, r.provider,
            (r.face_crop_ciphertext IS NOT NULL AND r.face_crop_retained_until > now()) AS has_crop,
            r.verified_at > now() - interval '5 years' AS within_five_years,
            o.verified_at AS original_verified_at, o.method AS original_method, o.result AS original_result,
            o.document_type AS original_document_type, o.document_number_last4 AS original_last4,
            (o.document_number_ciphertext IS NOT NULL) AS original_number_stored,
            o.number_unavailable AS original_unavailable, o.inspector_staff_id AS original_inspector,
            o.issuing_jurisdiction AS original_jurisdiction, o.issuing_country AS original_country,
            o.expiry_date AS original_expiry,
            o.verified_at > now() - interval '5 years' AS original_within_five
       FROM idv_check_records r
       LEFT JOIN idv_check_records o
         ON o.record_id = r.original_record_id
        AND o.tenant_id = r.tenant_id
        AND o.legal_entity_id = r.legal_entity_id
      WHERE r.tenant_id = $1 AND r.legal_entity_id = $2 AND r.client_id = $3
      ORDER BY r.verified_at DESC, r.record_id DESC`,
    [actor.tenantId, actor.legalEntityId, clientId],
  );
  const earlier = await latestFullCheck(q, actor, clientId);
  const links = await q.query(
    `SELECT record_id, deal_id FROM idv_check_deals
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND client_id = $3`,
    [actor.tenantId, actor.legalEntityId, clientId],
  );
  const dealsByRecord = new Map<string, string[]>();
  for (const link of links.rows) {
    const id = String(link.record_id);
    const deal = String(link.deal_id);
    const list = dealsByRecord.get(id) ?? [];
    if (deal && !list.includes(deal)) list.push(deal);
    dealsByRecord.set(id, list);
  }
  const staffNameById = await staffDisplayNames(q, actor.tenantId, found.rows.flatMap((row) => [
    str(row, "inspector_staff_id") || "",
    str(row, "original_inspector") || "",
  ]));
  const staffName = (id: string | null) => (id && staffNameById.get(id.toLowerCase())) || null;
  const records = found.rows.map((row) => {
    const when = new Date(String(row.verified_at));
    const stamp = branchStamp(when, facts.timeZone);
    const method = String(row.method) as CheckMethod;
    const providerName = str(row, "provider") === "didit" ? "didit" : "persona";
    const rowTest = providerName === "didit" ? !diditLiveAllowed(env) : test;
    const label = methodLabel(method, providerName);
    const hasCrop = row.has_crop === true && shop.faceCrop;
    const last = str(row, "document_number_last4");
    const expiryIso = day(row.expiry_date);
    const expiredStamp = expiryIso && isPastExpiry(expiryIso, facts.timeZone) ? expiredLine(expiryIso) : null;
    const originalWhen = row.original_verified_at ? new Date(String(row.original_verified_at)) : when;
    const originalMethod = (str(row, "original_method") ?? method) as CheckMethod;
    const returningStamp = method === "returning_client"
      ? returningLine(branchStamp(originalWhen, facts.timeZone).date, METHOD_LABEL[originalMethod] ?? METHOD_LABEL.in_person)
      : null;
    const result = String(row.result);
    const docType = str(row, "document_type");
    const typeRow = resolveIdType(docType);
    const line = expiredStamp
      ?? (result === "declined" ? notPassedLine(stamp.date)
        : result === "needs_review" ? underReviewLine(stamp.date)
          : result === "method_not_completed" ? INCOMPLETE_LINE
            : returningStamp ?? (result === "pass"
              ? idCheckedLine(stamp.date, label, rowTest && method === "id_and_selfie")
              : PROGRESS_LINE));
    const originalExpiry = day(row.original_expiry);
    const originalType = str(row, "original_document_type");
    const originalTypeRow = resolveIdType(originalType);
    const originalSeen = row.original_verified_at ? branchStamp(new Date(String(row.original_verified_at)), facts.timeZone).date : null;
    const standingInput = {
      result,
      method,
      line,
      maskedNumber: last ? `•••• ${last}` : null,
      numberUnavailable: row.number_unavailable === true,
      withinFiveYears: row.within_five_years === true,
      documentExpired: Boolean(expiredStamp),
      acceptedPhotoId: !!(typeRow && typeRow.photo && typeRow.acceptedAsId),
      numberStored: row.number_stored === true,
      issuingJurisdiction: str(row, "issuing_jurisdiction"),
      issuingCountry: str(row, "issuing_country"),
      staffSeen: str(row, "inspector_staff_id"),
      staffName: staffName(str(row, "inspector_staff_id")),
      seenOn: stamp.date,
      documentType: docType,
      expiryIso,
      sameShop: true,
      testPass: rowTest && method === "id_and_selfie" && result === "pass",
      original: method === "returning_client" || result === "returning_confirmed" ? {
        result: str(row, "original_result") ?? "",
        method: originalMethod,
        line: "",
        maskedNumber: str(row, "original_last4") ? `•••• ${str(row, "original_last4")}` : null,
        numberUnavailable: row.original_unavailable === true,
        withinFiveYears: row.original_within_five === true,
        documentExpired: Boolean(originalExpiry && isPastExpiry(originalExpiry, facts.timeZone)),
        acceptedPhotoId: !!(originalTypeRow && originalTypeRow.photo && originalTypeRow.acceptedAsId),
        numberStored: row.original_number_stored === true,
        issuingJurisdiction: str(row, "original_jurisdiction"),
        issuingCountry: str(row, "original_country"),
        staffSeen: str(row, "original_inspector"),
        staffName: staffName(str(row, "original_inspector")),
        seenOn: originalSeen,
        documentType: originalType,
        expiryIso: originalExpiry,
        sameShop: true,
        original: null,
      } : null,
    };
    const deals = dealsByRecord.get(String(row.record_id)) ?? [];
    const columnDeal = str(row, "deal_id");
    if (columnDeal && !deals.includes(columnDeal)) deals.unshift(columnDeal);
    return {
      recordId: row.record_id,
      tier: row.tier,
      method,
      methodLabel: label,
      result: row.result,
      standingInput,
      line,
      detail: DETAIL_LINE,
      verifiedDate: stamp.date,
      verifiedTime: stamp.time,
      nameOnId: str(row, "name_on_id"),
      documentType: str(row, "document_type"),
      maskedNumber: last ? `•••• ${last}` : null,
      numberUnavailable: row.number_unavailable === true,
      issuingJurisdiction: str(row, "issuing_jurisdiction"),
      issuingCountry: str(row, "issuing_country"),
      expiryDate: day(row.expiry_date),
      databaseStep: row.database_step,
      databaseMessage: row.database_step === "off" ? "The database step is not on yet. This check runs ID and selfie." : null,
      photoOnFile: hasCrop,
      photoLine: hasCrop ? null : NO_PHOTO_LINE,
      personaInquiryId: str(row, "persona_inquiry_id"),
      originalRecordId: str(row, "original_record_id"),
      dealId: str(row, "deal_id"),
      deals,
      statusLine: statusLine(result, method, stamp.date, rowTest, { expiredStamp, returningStamp }, providerName, line),
    };
  });
  return {
    ok: true as const,
    body: {
      clientId,
      detail: DETAIL_LINE,
      advice: earlier && earlier.advise && !earlier.due ? ADVISE_LINE : null,
      due: earlier?.due ? DUE_LINE : null,
      records: records.map(({ standingInput: _standing, ...record }) => record),
      headline: records[0]?.statusLine ?? NONE_LINE,
      standing: records.length
        ? idFileStanding(records[0]?.standingInput ?? null)
        : await typedGapStanding(q, actor, clientId),
      pepReview: await openPepReview(q, actor, clientId),
    },
  };
}

async function staffDisplayNames(q: Q, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.map((id) => id.trim().toLowerCase()).filter(Boolean))];
  const names = new Map<string, string>();
  if (!wanted.length) return names;
  try {
    const found = await q.query(
      `SELECT staff_id, name FROM staff_users WHERE tenant_id = $1 AND lower(staff_id) = ANY($2::text[])`,
      [tenantId, wanted],
    );
    for (const row of found.rows) {
      const name = String(row.name || "").trim();
      if (name) names.set(String(row.staff_id).toLowerCase(), name);
    }
  } catch {
    /* A check database without the staff list still prints the staff id. */
  }
  return names;
}

async function typedGapStanding(q: Q, actor: DeskActor, clientId: string): Promise<IdFileStanding> {
  try {
    const found = await q.query(
      `SELECT 1 FROM desk_client_identity_documents
        WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3
          AND coalesce(btrim(doc_number), '') <> ''
        LIMIT 1`,
      [clientId, actor.tenantId, actor.legalEntityId],
    );
    if (found.rows.length) return idFileStanding({ typedOnly: true, method: "in_person" });
  } catch {
    /* The check database does not hold the client papers. No typed ID to prompt. */
  }
  return idFileStanding(null);
}

async function openPepReview(q: Q, actor: DeskActor, clientId: string): Promise<"open" | null> {
  try {
    const found = await q.query(
      `SELECT 1 FROM client_pep_reviews
        WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3 AND status = 'open'
        LIMIT 1`,
      [clientId, actor.tenantId, actor.legalEntityId],
    );
    return found.rows.length ? "open" : null;
  } catch {
    return null;
  }
}

const NOT_ON_FILE = "No identity-document number is on this file yet.";

export type IdFileStanding = {
  onFile: boolean;
  chip: string;
  title: "Identified" | "Not identified" | "ID expired";
  line: string;
  gap: "missing ID" | "expired ID" | null;
};

/* One read of the latest check record. A pass, including in person and
   a confirmed returning client, is ID on file. Expired and every other
   result stay a gap. The browser prints this. It does not decide it. */
export type StandingInput = {
  result?: string;
  method?: string;
  line?: string;
  maskedNumber?: string | null;
  numberUnavailable?: boolean;
  withinFiveYears?: boolean;
  documentExpired?: boolean;
  acceptedPhotoId?: boolean;
  numberStored?: boolean;
  issuingJurisdiction?: string | null;
  issuingCountry?: string | null;
  staffSeen?: string | null;
  staffName?: string | null;
  seenOn?: string | null;
  documentType?: string | null;
  expiryIso?: string | null;
  sameShop?: boolean;
  typedOnly?: boolean;
  testPass?: boolean;
  original?: StandingInput | null;
};

/* An in-person record is the typed ID. It counts only with every fact
   the desk can check. A missing fact is not a pass. */
function inPersonReady(record: StandingInput): boolean {
  return record.method === "in_person"
    && record.result === "pass"
    && record.acceptedPhotoId === true
    && record.numberStored === true
    && !!record.maskedNumber
    && !!record.issuingJurisdiction
    && !!record.issuingCountry
    && !!record.staffSeen
    && !!record.seenOn
    && !!record.expiryIso
    && record.sameShop !== false
    && record.numberUnavailable !== true;
}

/* The passed scan-and-selfie badge. Pending, a failure, a returning
   client, and a check from another shop do not use this sentence. */
function scanVerifiedChip(record: StandingInput): string | null {
  if (record.sameShop === false) return null;
  if (record.method !== "id_and_selfie" || record.result !== "pass") return null;
  const date = (record.seenOn || "").trim();
  if (!date || !qualifiesAsId(record)) return null;
  return verifiedScanChip(date, record.testPass === true);
}

function qualifiesAsId(record: StandingInput | null | undefined): boolean {
  if (!record || record.typedOnly) return false;
  if (record.documentExpired) return false;
  if (record.withinFiveYears === false) return false;
  if (record.result === "expired" || (record.line || "").startsWith("Expired")) return false;
  if (record.result === "needs_review") return false;
  if (record.method === "returning_client" || record.result === "returning_confirmed") {
    return qualifiesAsId(record.original ?? null);
  }
  if (record.method === "in_person") return inPersonReady(record);
  if (record.result !== "pass") return false;
  if (record.numberUnavailable) return false;
  if (!record.maskedNumber) return false;
  return true;
}

/* ID on file only when the last 4 are stored, the number was available,
   the document is not expired, and the check is under 5 years old.
   A returning client counts only through an original record that meets
   the same test. The browser prints this. It does not decide it. */
export function idFileStanding(latest: StandingInput | null): IdFileStanding {
  if (!latest) {
    return { onFile: false, chip: "Missing ID", title: "Not identified", line: NOT_ON_FILE, gap: "missing ID" };
  }
  if (latest.typedOnly) {
    return { onFile: false, chip: HAND_TYPED_LINE, title: "Not identified", line: HAND_TYPED_LINE, gap: "missing ID" };
  }
  if (latest.method === "in_person" && (!latest.staffSeen || !latest.seenOn)) {
    return { onFile: false, chip: HAND_TYPED_LINE, title: "Not identified", line: HAND_TYPED_LINE, gap: "missing ID" };
  }
  const line = latest.line || "";
  if (qualifiesAsId(latest)) {
    const shown = latest.method === "in_person"
      ? seenInPersonLine(
        latest.staffName || latest.staffSeen || "",
        latest.documentType || "photo ID",
        civilDateWords(latest.expiryIso || ""),
        latest.seenOn || "",
      )
      : line;
    return { onFile: true, chip: scanVerifiedChip(latest) || "ID on file", title: "Identified", line: shown, gap: null };
  }
  const expired = latest.documentExpired || latest.result === "expired" || line.startsWith("Expired");
  if (expired) {
    const shown = latest.method === "in_person" && latest.expiryIso
      ? expiredNextDealLine(civilDateWords(latest.expiryIso))
      : (line || "Expired");
    return { onFile: false, chip: "ID expired", title: "ID expired", line: shown, gap: "expired ID" };
  }
  if (latest.withinFiveYears === false) {
    return { onFile: false, chip: TOO_OLD_LINE, title: "Not identified", line: TOO_OLD_LINE, gap: "missing ID" };
  }
  if (latest.result === "declined" || latest.result === "needs_review" || latest.result === "method_not_completed") {
    const shown = (latest.line || "").trim() || NOT_ON_FILE;
    return { onFile: false, chip: shown, title: "Not identified", line: shown, gap: "missing ID" };
  }
  return { onFile: false, chip: "Missing ID", title: "Not identified", line: NOT_ON_FILE, gap: "missing ID" };
}

function statusLine(
  result: string, method: CheckMethod, date: string, test: boolean,
  extra: { expiredStamp: string | null; returningStamp: string | null },
  provider: "persona" | "didit" = "persona",
  checkedLine = "",
): string {
  if (extra.expiredStamp) return extra.expiredStamp;
  if (result === "needs_review") return underReviewLine(date);
  if (result === "declined") return notPassedLine(date);
  if (result === "method_not_completed") return INCOMPLETE_LINE;
  if (result === "expired") return extra.expiredStamp ?? "Expired";
  if (result === "returning_confirmed" || method === "returning_client") return extra.returningStamp ?? "Returning client";
  if (result === "pass" && method === "in_person") return idCheckedLine(date, METHOD_LABEL.in_person, false);
  /* Persona keeps the scan-and-selfie badge it had before Didit.
     A Didit pass uses the check line. It does not say Missing ID. */
  if (result === "pass" && method === "id_and_selfie") {
    if (provider === "didit") return checkedLine;
    return verifiedScanChip(date, test);
  }
  return PROGRESS_LINE;
}

function bindFor(actor: DeskActor, recordId: string, purpose: SecretBind["purpose"], version: unknown): SecretBind {
  const keyVersion = Number(version);
  return {
    purpose, tenantId: actor.tenantId, recordId,
    keyVersion: Number.isInteger(keyVersion) && keyVersion >= 1 ? keyVersion : KEY_VERSION,
  };
}

function badNote(note: string | undefined, secret: string): Step<never> | null {
  if (note === undefined || note === "") return null;
  const trimmed = note.trim();
  if (trimmed.length > 500) return fail(400, "invalid_request", "The note is too long.");
  if (secret && trimmed.includes(secret)) return fail(400, "invalid_request", "The note cannot include the document number.");
  return null;
}

export async function revealNumber(db: Db, actor: DeskActor, recordId: string, reason: string, note: string | undefined, env: NodeJS.ProcessEnv): Promise<Step<{ number: string }>> {
  if (!REVEAL_ROLES.has(actor.role)) return fail(403, "forbidden", "You cannot reveal this document number.");
  if (!REVEAL_REASONS.has(reason)) return fail(400, "invalid_request", "Pick a reason for revealing the document number.");
  try {
    return await db.transaction(async (tx) => {
      const q = dbQuery(tx);
      const found = await q.query(
        `SELECT client_id, deal_id, document_number_ciphertext, key_version
           FROM idv_check_records
          WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
        [recordId, actor.tenantId, actor.legalEntityId],
      );
      const row = found.rows[0];
      if (!row || !str(row, "document_number_ciphertext")) return fail(404, "not_found", "That ID check is not on this shop.");
      const number = await decryptSecret(String(row.document_number_ciphertext), bindFor(actor, recordId, PURPOSE_NUMBER, row.key_version), env);
      const refused = badNote(note, number);
      if (refused) return refused;
      await q.query(
        `INSERT INTO idv_number_reveals
          (reveal_id, tenant_id, legal_entity_id, record_id, client_id, deal_id, staff_id, role, reason, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          `rev_${randomUUID()}`, actor.tenantId, actor.legalEntityId, recordId, row.client_id,
          str(row, "deal_id"), actor.staffId, actor.role, reason, note?.trim() || null,
        ],
      );
      return { ok: true, body: { number } };
    });
  } catch {
    return fail(500, "reveal_failed", "The document number could not be shown.");
  }
}

export async function listReveals(db: Db, actor: DeskActor, recordId: string): Promise<Step<{ reveals: Array<{ revealId: string; staffId: string; role: string; reason: string; note: string | null; date: string; time: string }> }>> {
  if (!REVEAL_ROLES.has(actor.role)) return fail(403, "forbidden", "You cannot read this reveal list.");
  const q = dbQuery(db);
  const owned = await q.query(
    `SELECT 1 FROM idv_check_records WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
    [recordId, actor.tenantId, actor.legalEntityId],
  );
  if (!owned.rows.length) return fail(404, "not_found", "That ID check is not on this shop.");
  const facts = await branchFacts(q, actor);
  const found = await q.query(
    `SELECT reveal_id, staff_id, role, reason, note, revealed_at
       FROM idv_number_reveals
      WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3
      ORDER BY revealed_at DESC, reveal_id DESC`,
    [recordId, actor.tenantId, actor.legalEntityId],
  );
  return {
    ok: true,
    body: {
      reveals: found.rows.map((row) => {
        const stamp = branchStamp(new Date(String(row.revealed_at)), facts.timeZone);
        return {
          revealId: String(row.reveal_id),
          staffId: String(row.staff_id),
          role: String(row.role),
          reason: String(row.reason),
          note: str(row, "note"),
          date: stamp.date,
          time: stamp.time,
        };
      }),
    },
  };
}

export async function viewFaceCrop(db: Db, actor: DeskActor, recordId: string, reason: string, note: string | undefined, env: NodeJS.ProcessEnv): Promise<Step<{ contentType: string; dataBase64: string }>> {
  if (!CROP_ROLES.has(actor.role)) return fail(403, "forbidden", "You cannot view this photo.");
  if (reason !== CROP_REASON) return fail(400, "invalid_request", "The photo is shown for comparison by eye only.");
  const shop = await loadShopIdv(db, actor.legalEntityId);
  if (!shop.faceCrop) return fail(409, "crop_off", NO_PHOTO_LINE);
  try {
    return await db.transaction(async (tx) => {
      const q = dbQuery(tx);
      const found = await q.query(
        `SELECT client_id, deal_id, key_version,
                CASE WHEN face_crop_retained_until > now() THEN face_crop_ciphertext ELSE NULL END AS face_crop_ciphertext
           FROM idv_check_records
          WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
        [recordId, actor.tenantId, actor.legalEntityId],
      );
      const row = found.rows[0];
      if (!row) return fail(404, "not_found", "That ID check is not on this shop.");
      if (!str(row, "face_crop_ciphertext")) return fail(404, "no_photo", NO_PHOTO_LINE);
      const plain = await decryptSecret(String(row.face_crop_ciphertext), bindFor(actor, recordId, PURPOSE_CROP, row.key_version), env);
      const bytes = Buffer.from(plain, "base64");
      if (!isSmallCrop(bytes)) return fail(500, "crop_unreadable", "The photo could not be shown.");
      const refused = badNote(note, "");
      if (refused) return refused;
      await q.query(
        `INSERT INTO idv_crop_views
          (view_id, tenant_id, legal_entity_id, record_id, client_id, deal_id, staff_id, role, reason, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          `view_${randomUUID()}`, actor.tenantId, actor.legalEntityId, recordId, row.client_id,
          str(row, "deal_id"), actor.staffId, actor.role, CROP_REASON, note?.trim() || null,
        ],
      );
      return { ok: true, body: { contentType: "image/png", dataBase64: plain } };
    });
  } catch {
    return fail(500, "crop_unreadable", "The photo could not be shown.");
  }
}

export async function supersedeRecord(db: Db, actor: DeskActor, recordId: string, replacedBy: string): Promise<Step<{ ok: true }>> {
  const q = dbQuery(db);
  const owned = await q.query(
    `SELECT client_id, staff_id FROM idv_check_records WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
    [recordId, actor.tenantId, actor.legalEntityId],
  );
  const next = await q.query(
    `SELECT client_id FROM idv_check_records WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
    [replacedBy, actor.tenantId, actor.legalEntityId],
  );
  const prior = owned.rows[0];
  const later = next.rows[0];
  if (!prior || !later) return fail(404, "not_found", "That ID check is not on this shop.");
  if (String(prior.client_id) !== String(later.client_id)) return fail(404, "not_found", "That ID check is not on this client.");
  if (String(prior.staff_id) === actor.staffId) return fail(403, "forbidden", "Someone else has to supersede this ID check.");
  await q.query(
    `INSERT INTO idv_record_supersessions
      (supersession_id, record_id, superseded_by_record_id, tenant_id, legal_entity_id, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [`sup_${randomUUID()}`, recordId, replacedBy, actor.tenantId, actor.legalEntityId, actor.staffId],
  );
  return { ok: true, body: { ok: true } };
}

async function dealOnShop(q: Q, actor: DeskActor, dealId: string): Promise<boolean> {
  const lookups = [
    "SELECT 1 FROM quotes WHERE quote_id = $1 AND tenant_id = $2 AND legal_entity_id = $3 LIMIT 1",
    "SELECT 1 FROM ledger_transactions WHERE transaction_id = $1 AND tenant_id = $2 AND legal_entity_id = $3 LIMIT 1",
  ];
  for (const text of lookups) {
    try {
      const found = await q.query(text, [dealId, actor.tenantId, actor.legalEntityId]);
      if (found.rows.length) return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!/does not exist|no such table/i.test(message)) throw err;
    }
  }
  return false;
}

export async function linkRecordDeal(db: Db, actor: DeskActor, recordId: string, dealId: string): Promise<Step<{ ok: true }>> {
  const q = dbQuery(db);
  const owned = await q.query(
    `SELECT client_id FROM idv_check_records WHERE record_id = $1 AND tenant_id = $2 AND legal_entity_id = $3`,
    [recordId, actor.tenantId, actor.legalEntityId],
  );
  const row = owned.rows[0];
  if (!row) return fail(404, "not_found", "That ID check is not on this shop.");
  if (!await dealOnShop(q, actor, dealId)) return fail(404, "not_found", "That deal is not on this shop.");
  await linkDeal(q, actor, recordId, String(row.client_id), dealId);
  return { ok: true, body: { ok: true } };
}

export { NO_PHOTO_LINE, returningLine };
