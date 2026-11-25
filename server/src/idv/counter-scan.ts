/* Teller face-match attestation for a document-only counter scan.
   The staff user id, the role, and the time come from the session and
   the database clock. The client does not send them. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { dbQuery, writePersonaRecord, type DeskActor, type Step } from "./records.js";
import { diditSelection } from "./providers/didit.js";

const loadShared = createRequire(import.meta.url);
const faceMatch = loadShared("../../../shared/face-match-attestation.js") as { version: string; statement: string };
export const FACE_MATCH_STATEMENT = faceMatch.statement;
export const FACE_MATCH_VERSION = faceMatch.version;

export type FaceAttestation = {
  staffUserId: string;
  staffId: string;
  role: string;
  attestedAt: string;
  statement: string;
  statementVersion: string;
};

type InquiryRow = {
  reference_id: string;
  shop_id: string;
  branch_id: string;
  teller_id: string;
  client_id: string | null;
  check_method: string | null;
  id_scan_passed: boolean | null;
  status: string;
  provider_ref: string;
};

const fail = (status: number, error: string, message: string): Step<never> => ({ ok: false, status, error, message });

export async function latestFaceAttestation(
  db: Db, tenantId: string, shopId: string, referenceId: string,
): Promise<FaceAttestation | null> {
  const found = await dbQuery(db).query(
    `SELECT staff_user_id, staff_id, role, attested_at, statement, statement_version
       FROM idv_face_attestations
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND reference_id = $3
      ORDER BY attested_at DESC
      LIMIT 1`,
    [tenantId, shopId, referenceId],
  );
  const row = found.rows[0];
  if (!row?.attested_at) return null;
  return {
    staffUserId: String(row.staff_user_id),
    staffId: String(row.staff_id),
    role: String(row.role),
    attestedAt: new Date(String(row.attested_at)).toISOString(),
    statement: String(row.statement),
    statementVersion: String(row.statement_version ?? ""),
  };
}

async function insertAttestation(db: Db, input: {
  tenantId: string; shopId: string; branchId: string; clientId: string; referenceId: string;
  staffUserId: string; staffId: string; role: string;
}): Promise<FaceAttestation> {
  const inserted = await dbQuery(db).query(
    `INSERT INTO idv_face_attestations (
       attestation_id, tenant_id, legal_entity_id, branch_id, client_id, reference_id,
       staff_user_id, staff_id, role, statement, statement_version
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING attested_at`,
    [
      `att_${randomUUID()}`, input.tenantId, input.shopId, input.branchId, input.clientId, input.referenceId,
      input.staffUserId, input.staffId, input.role, FACE_MATCH_STATEMENT, FACE_MATCH_VERSION,
    ],
  );
  return {
    staffUserId: input.staffUserId,
    staffId: input.staffId,
    role: input.role,
    attestedAt: new Date(String(inserted.rows[0]?.attested_at)).toISOString(),
    statement: FACE_MATCH_STATEMENT,
    statementVersion: FACE_MATCH_VERSION,
  };
}

async function existingPass(db: Db, shopId: string, providerRef: string): Promise<string | null> {
  const found = await dbQuery(db).query(
    `SELECT record_id FROM idv_check_records
      WHERE legal_entity_id = $1 AND persona_inquiry_id = $2 AND provider = 'didit'
        AND method = 'counter_id_scan' AND result = 'pass'
      LIMIT 1`,
    [shopId, providerRef],
  );
  const id = found.rows[0]?.record_id;
  return typeof id === "string" ? id : null;
}

/* Writes the pass only when this inquiry is still the in-progress ID
   approval. A declined, expired, or review status does not match, and
   then no pass row is written. The caller holds the inquiry row. */
export async function writeCounterScanPass(db: Db, input: {
  tenantId: string; shopId: string; branchId: string; tellerId: string; clientId: string;
  providerRef: string; checksLine: string; attestation: FaceAttestation;
}): Promise<string | null> {
  const updated = await dbQuery(db).query(
    `UPDATE idv_inquiries
        SET status = 'approved'
      WHERE provider = 'didit' AND provider_ref = $1
        AND status = 'in progress'
        AND id_scan_passed IS TRUE
        AND status NOT IN ('approved', 'declined', 'failed', 'expired')
      RETURNING reference_id`,
    [input.providerRef],
  );
  if (!updated.rows.length) return null;
  const already = await existingPass(db, input.shopId, input.providerRef);
  if (already) return already;
  const recordId = `idc_${randomUUID()}`;
  await writePersonaRecord(db, {
    recordId,
    tenantId: input.tenantId,
    legalEntityId: input.shopId,
    branchId: input.branchId,
    staffId: input.tellerId,
    clientId: input.clientId,
    tier: "3",
    inquiryId: input.providerRef,
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
    result: "pass",
    providerChecks: input.checksLine,
    governmentId: null,
    selfieId: null,
    templateId: null,
    templateVersion: null,
    provider: "didit",
    method: "counter_id_scan",
    databaseStep: "not_applicable",
    inspectorStaffId: input.attestation.staffId,
    attestation: input.attestation.statement,
    attestationStaffId: input.attestation.staffUserId,
    attestationRole: input.attestation.role,
    attestationAt: input.attestation.attestedAt,
  });
  return recordId;
}

async function auditAttest(db: Db, actor: DeskActor, referenceId: string, verified: boolean): Promise<void> {
  await dbQuery(db).query(
    `INSERT INTO audit_events (id, tenant_id, legal_entity_id, branch_id, actor_id, action, detail)
     VALUES ($1, $2, $3, $4, $5, 'idv.counter_scan_attested', $6::jsonb)`,
    [
      randomUUID(), actor.tenantId, actor.legalEntityId, actor.branchId, actor.userId,
      JSON.stringify({ referenceId, verified }),
    ],
  );
}

export async function recordCounterFaceMatch(
  db: Db,
  actor: DeskActor,
  input: { clientId: string; providerRef: string; attested: boolean },
  env: NodeJS.ProcessEnv,
): Promise<Step<{ verified: boolean; recordId: string | null; pending: boolean }>> {
  if (input.attested !== true) {
    return fail(400, "attestation_required", "The teller has to confirm they compared the customer's face to the ID photo.");
  }
  const tenant = await dbQuery(db).query("SELECT is_test_shop FROM tenants WHERE id = $1", [actor.tenantId]);
  const testShop = tenant.rows[0]?.is_test_shop === true;
  const selection = diditSelection(env, testShop);
  if (!selection.ok) return fail(409, "IDV_PROVIDER", selection.message);
  const owned = await dbQuery(db).query(
    "SELECT 1 FROM desk_clients WHERE client_id = $1 AND tenant_id = $2 AND legal_entity_id = $3",
    [input.clientId, actor.tenantId, actor.legalEntityId],
  );
  if (!owned.rows.length) return fail(404, "not_found", "That client is not on this shop.");

  return db.transaction(async (tx) => {
    const locked = await dbQuery(tx).query(
      `SELECT reference_id, shop_id, branch_id, teller_id, client_id, check_method, id_scan_passed, status, provider_ref
         FROM idv_inquiries
        WHERE provider = 'didit' AND provider_ref = $1 AND shop_id = $2
        FOR UPDATE`,
      [input.providerRef, actor.legalEntityId],
    );
    const row = locked.rows[0] as InquiryRow | undefined;
    if (!row || row.client_id !== input.clientId) return fail(404, "not_found", "That ID scan is not on this client.");
    if (row.check_method !== "counter_id_scan") {
      return fail(409, "IDV_METHOD", "That check is not a counter ID scan.");
    }
    if (row.status !== "in progress" || row.id_scan_passed !== true) {
      await auditAttest(tx, actor, row.reference_id, false);
      return fail(409, "scan_not_ready", "The ID scan is not ready to confirm.");
    }
    const attestation = await insertAttestation(tx, {
      tenantId: actor.tenantId,
      shopId: row.shop_id,
      branchId: row.branch_id,
      clientId: input.clientId,
      referenceId: row.reference_id,
      staffUserId: actor.userId,
      staffId: actor.staffId,
      role: actor.role,
    });
    const recordId = await writeCounterScanPass(tx, {
      tenantId: actor.tenantId,
      shopId: row.shop_id,
      branchId: row.branch_id,
      tellerId: row.teller_id,
      clientId: input.clientId,
      providerRef: row.provider_ref,
      checksLine: "ID passed",
      attestation,
    });
    if (!recordId) {
      await auditAttest(tx, actor, row.reference_id, false);
      return fail(409, "scan_not_ready", "The ID scan is not ready to confirm.");
    }
    await auditAttest(tx, actor, row.reference_id, true);
    return { ok: true, body: { verified: true, recordId, pending: false } };
  });
}
