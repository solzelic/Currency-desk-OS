/* Didit webhook bookkeeping. The decision body is not stored and not
   logged. A repeat of the same session id and status is one event.
   Failed, abandoned, and declined scans are not billed. */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { latestFaceAttestation, writeCounterScanPass } from "./counter-scan.js";
import { chargeForDiditOutcome, diditRuntimeAllowed } from "./providers/didit.js";
import type { IdvResult } from "./provider.js";
import { dbQuery, writePersonaRecord } from "./records.js";
import { locateIdvInquiry } from "./store.js";
import { classifyCheck, type CheckMethod, type CheckResult } from "./tiers.js";

const SUPERSEDE_OUTCOME = new Set<IdvResult["outcome"]>(["declined", "expired", "review"]);

const RECORDABLE = new Set<IdvResult["outcome"]>(["approved", "declined", "failed", "expired", "review"]);

function statusWord(result: IdvResult): string {
  if (result.inquiryStatus) return result.inquiryStatus;
  if (result.outcome === "review") return "needs review";
  return result.outcome;
}

async function shopIsTest(db: Db, shopId: string): Promise<boolean> {
  const found = await dbQuery(db).query(
    `SELECT t.is_test_shop
       FROM legal_entities e
       JOIN tenants t ON t.id = e.tenant_id
      WHERE e.id = $1
      LIMIT 1`,
    [shopId],
  );
  return found.rows[0]?.is_test_shop === true;
}

async function writeDiditAudit(
  db: Db,
  shop: { tenantId: string; shopId: string; branchId: string; tellerId: string },
  action: "idv.didit_result" | "idv.didit_webhook_refused" | "idv.counter_scan_superseded",
  detail: Record<string, string | boolean>,
): Promise<void> {
  await dbQuery(db).query(
    `INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [randomUUID(), shop.tenantId, shop.shopId, shop.branchId, shop.tellerId || null, action, JSON.stringify(detail)],
  );
}

async function auditShop(db: Db, providerRef: string) {
  const found = await dbQuery(db).query(
    `SELECT i.shop_id, i.branch_id, i.teller_id, e.tenant_id
       FROM idv_inquiries i
       JOIN legal_entities e ON e.id = i.shop_id
      WHERE i.provider = 'didit' AND i.provider_ref = $1
      LIMIT 1`,
    [providerRef],
  );
  const row = found.rows[0];
  if (!row?.tenant_id || !row.shop_id || !row.branch_id) return null;
  return {
    tenantId: String(row.tenant_id),
    shopId: String(row.shop_id),
    branchId: String(row.branch_id),
    tellerId: typeof row.teller_id === "string" ? row.teller_id : "",
  };
}

function storedMethod(value: string | null): CheckMethod {
  if (value === "counter_id_scan" || value === "counter_full" || value === "customer_preverify") return value;
  return "id_and_selfie";
}

/* ID and selfie, including the full counter check, still needs the selfie.
   A counter ID scan does not. That pass is written only with an attestation. */
function checkResult(result: IdvResult): CheckResult {
  const selfie = result.outcome === "approved" && result.checksPassed === true ? "approved" : null;
  return classifyCheck(result.outcome, selfie).result;
}

export async function finishDiditWebhook(
  db: Db,
  result: IdvResult,
  env: NodeJS.ProcessEnv = process.env,
): Promise<"stored" | "duplicate" | "unknown" | "conflict"> {
  /* No settle. Failed, abandoned, and declined stay no_charge.
     A pass is unbilled in this sandbox slice. */
  const charge = chargeForDiditOutcome(result.outcome);
  if (charge !== "no_charge" && charge !== "unbilled") throw new Error("didit_charge_unexpected");
  const located = await locateIdvInquiry(db, result);
  if (located === "unknown") return "unknown";
  if (located === "conflict") {
    const shop = await auditShop(db, result.providerRef);
    if (shop) await writeDiditAudit(db, shop, "idv.didit_webhook_refused", { reason: "vendor_data_conflict" });
    return "conflict";
  }
  if (!diditRuntimeAllowed(env)) {
    await writeDiditAudit(db, located, "idv.didit_webhook_refused", { reason: "runtime_locked" });
    return "unknown";
  }
  if (!await shopIsTest(db, located.shopId)) {
    await writeDiditAudit(db, located, "idv.didit_webhook_refused", { reason: "not_test_shop" });
    return "unknown";
  }
  const method = storedMethod(located.checkMethod);
  const idReady = method === "counter_id_scan" && result.outcome === "approved" && result.idPassed === true;
  return db.transaction(async (tx) => {
    const q = dbQuery(tx);
    await q.query(
      "SELECT reference_id FROM idv_inquiries WHERE provider = $1 AND provider_ref = $2 FOR UPDATE",
      [result.provider, result.providerRef],
    );
    const attested = method === "counter_id_scan"
      ? await latestFaceAttestation(tx, located.tenantId, located.shopId, located.referenceId)
      : null;
    const awaiting = idReady && !attested;
    const inserted = await q.query(
      `INSERT INTO idv_events (event_id, provider, provider_ref, reference_id, shop_id, branch_id, teller_id, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [result.eventId, result.provider, result.providerRef, located.referenceId, located.shopId, located.branchId, located.tellerId, result.outcome],
    );
    if (!inserted.rows.length) return "duplicate" as const;
    /* An approved ID stays in progress until the attestation writes the pass.
       id_scan_passed moves only with a status this guard accepts.
       A final status is not reopened, and any other status clears the flag. */
    const next = idReady ? "in progress" : statusWord(result);
    const updated = await q.query(
      `UPDATE idv_inquiries
          SET status = $1,
              id_scan_passed = CASE
                WHEN $2::text = 'counter_id_scan' AND $1 = 'in progress' AND $3::boolean IS TRUE THEN true
                WHEN $2::text = 'counter_id_scan' THEN false
                ELSE id_scan_passed
              END
        WHERE provider = $4 AND provider_ref = $5
          AND status NOT IN ('approved', 'declined', 'failed', 'expired')
          AND NOT (status = 'needs review' AND $1 = 'in progress')
        RETURNING reference_id`,
      [next, method, idReady, result.provider, result.providerRef],
    );
    /* A later status that does not replace the stored one writes no check row.
       An approved document scan with no attestation is not a verification. */
    await writeDiditAudit(tx as Db, located, "idv.didit_result", {
      outcome: result.outcome,
      referenceId: located.referenceId,
      applied: updated.rows.length > 0,
    });
    /* A pass already approved the inquiry, so the guard above skips a later
       Declined, Expired, or In Review. Write a new row. Leave the pass row. */
    if (!updated.rows.length && method === "counter_id_scan" && SUPERSEDE_OUTCOME.has(result.outcome) && located.clientId) {
      const opened = await q.query(
        `UPDATE idv_inquiries
            SET status = $1, id_scan_passed = false
          WHERE provider = 'didit' AND provider_ref = $2 AND status = 'approved'
          RETURNING reference_id`,
        [statusWord(result), result.providerRef],
      );
      if (opened.rows.length) {
        const prior = await q.query(
          `SELECT record_id FROM idv_check_records
            WHERE legal_entity_id = $1 AND persona_inquiry_id = $2 AND provider = 'didit'
              AND method = 'counter_id_scan' AND result = 'pass'
            ORDER BY verified_at DESC
            LIMIT 1`,
          [located.shopId, result.providerRef],
        );
        const recordId = `idc_${randomUUID()}`;
        const superseded = classifyCheck(result.outcome, null, {
          method: "counter_id_scan",
          idPassed: result.idPassed === true,
          attested: false,
        }).result;
        await writePersonaRecord(tx, {
          recordId,
          tenantId: located.tenantId,
          legalEntityId: located.shopId,
          branchId: located.branchId,
          staffId: located.tellerId,
          clientId: located.clientId,
          tier: "3",
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
          result: superseded,
          providerChecks: result.idPassed ? "ID passed" : "ID not passed",
          governmentId: null,
          selfieId: null,
          templateId: null,
          templateVersion: null,
          provider: "didit",
          method: "counter_id_scan",
          databaseStep: "not_applicable",
        });
        const priorId = prior.rows[0]?.record_id;
        if (typeof priorId === "string") {
          await q.query(
            `INSERT INTO idv_record_supersessions
              (supersession_id, record_id, superseded_by_record_id, tenant_id, legal_entity_id, staff_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [`sup_${randomUUID()}`, priorId, recordId, located.tenantId, located.shopId, located.tellerId],
          );
        }
        await writeDiditAudit(tx as Db, located, "idv.counter_scan_superseded", {
          outcome: result.outcome,
          referenceId: located.referenceId,
          recordId,
        });
      }
      return "stored" as const;
    }
    if (awaiting || !updated.rows.length || !RECORDABLE.has(result.outcome) || !located.clientId) {
      return "stored" as const;
    }
    if (method === "counter_id_scan" && idReady && attested) {
      await writeCounterScanPass(tx, {
        tenantId: located.tenantId,
        shopId: located.shopId,
        branchId: located.branchId,
        tellerId: located.tellerId,
        clientId: located.clientId,
        providerRef: located.providerRef,
        checksLine: "ID passed",
        attestation: attested,
      });
      return "stored" as const;
    }
    const tier = method === "counter_id_scan" ? "3" : located.requestedTier === "4" ? "4" : "3";
    const counterResult = method === "counter_id_scan"
      ? classifyCheck(result.outcome, null, { method, idPassed: result.idPassed === true, attested: false }).result
      : checkResult(result);
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
      result: counterResult,
      providerChecks: method === "counter_id_scan"
        ? (result.idPassed ? "ID passed" : "ID not passed")
        : (result.checksLine ?? "ID not passed, liveness not passed, face match not passed"),
      governmentId: null,
      selfieId: null,
      templateId: null,
      templateVersion: null,
      provider: "didit",
      method,
      databaseStep: tier === "4" ? "off" : "not_applicable",
    });
    return "stored" as const;
  });
}
