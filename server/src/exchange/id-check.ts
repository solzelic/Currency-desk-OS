/* This shop's ID check. The number is encrypted. A read returns the last
   four characters. A reveal or an export writes an append-only row first.
   The query is always this legal entity. It has no parameter for any
   other shop, and it must not grow one. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { decryptSecret, encryptSecret } from "../auth/totp-secret.js";
import { civilToday } from "../civil-date.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";

const require = createRequire(import.meta.url);
const rules = require("../../../shared/exchange-v29.js") as {
  maskIdNumber: (value: string | null | undefined) => string | null;
  idBadge: (checkedOn: string, methodLabel: string, today: string) => string | null;
  returningDecision: (input: {
    checkedOn: string | null;
    today: string;
    doubt?: boolean;
    confirmedHigh?: boolean;
  }) => { offered: boolean; recommended: boolean; reason: string };
  revealNoteOk: (reason: { active?: boolean; requiresNote?: boolean; minNoteLength?: number } | null, note: string) => boolean;
  NO_EARLIER_CHECK: string;
};

export const SHOP_CHECK_SQL = `SELECT check_id, method, doc_type, number_ciphertext, number_last4, number_length,
            issuer_region, issuer_country, expires_on::text AS expires_on, checked_on::text AS checked_on,
            checked_by, lifts_lock, original_checked_on::text AS original_checked_on, doubt
       FROM client_id_checks
      WHERE legal_entity_id = $1 AND customer_id = $2
      ORDER BY checked_on DESC, created_at DESC
      LIMIT 1`;

const METHOD_LABEL: Record<string, string> = {
  photo_id_in_person: "in person",
  returning_client: "returning client",
};

export type ShopCheck = {
  checkId: string;
  method: string;
  docType: string | null;
  last4: string | null;
  numberLength: number | null;
  ciphertext: string | null;
  issuerRegion: string | null;
  issuerCountry: string | null;
  expiresOn: string | null;
  checkedOn: string;
  checkedBy: string;
  liftsLock: boolean;
  originalCheckedOn: string | null;
  doubt: boolean;
};

export type RevealReason = {
  code: string;
  label: string;
  requiresNote: boolean;
  minNoteLength: number;
  active: boolean;
};

const REVEAL_ROLES = new Set(["branch_manager", "supervisor", "administrator", "compliance_officer"]);

function day(value: unknown): string | null {
  if (value == null || value === "") return null;
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function rowToCheck(row: Record<string, unknown> | undefined): ShopCheck | null {
  if (!row) return null;
  return {
    checkId: String(row.check_id),
    method: String(row.method),
    docType: row.doc_type == null ? null : String(row.doc_type),
    last4: row.number_last4 == null ? null : String(row.number_last4),
    numberLength: row.number_length == null ? null : Number(row.number_length),
    ciphertext: row.number_ciphertext == null ? null : String(row.number_ciphertext),
    issuerRegion: row.issuer_region == null ? null : String(row.issuer_region),
    issuerCountry: row.issuer_country == null ? null : String(row.issuer_country),
    expiresOn: day(row.expires_on),
    checkedOn: day(row.checked_on) || "",
    checkedBy: String(row.checked_by),
    liftsLock: row.lifts_lock === true,
    originalCheckedOn: day(row.original_checked_on),
    doubt: row.doubt === true,
  };
}

export function maskedNumber(check: ShopCheck): string | null {
  if (!check.last4) return null;
  if (check.numberLength != null && check.numberLength <= 4) return check.last4;
  return rules.maskIdNumber(check.last4.padStart(5, "x"));
}

export function badgeFor(check: ShopCheck | null): string | null {
  if (!check || !check.liftsLock) return null;
  const label = METHOD_LABEL[check.method];
  if (!label) return null;
  return rules.idBadge(check.checkedOn, label, civilToday());
}

export async function loadShopCheck(
  client: pg.PoolClient,
  legalEntityId: string,
  customerId: string,
): Promise<ShopCheck | null> {
  const found = await client.query(SHOP_CHECK_SQL, [legalEntityId, customerId]);
  return rowToCheck(found.rows[0]);
}

export async function confirmedHigh(
  client: pg.PoolClient,
  legalEntityId: string,
  customerId: string,
): Promise<boolean> {
  const found = await client.query(
    `SELECT confirmed FROM shop_risk_ratings WHERE legal_entity_id = $1 AND customer_id = $2`,
    [legalEntityId, customerId],
  );
  return String(found.rows[0]?.confirmed || "").toLowerCase() === "high";
}

export function checkStillLifts(check: ShopCheck | null, today: string, high: boolean): boolean {
  if (!check || !check.liftsLock) return false;
  if (check.expiresOn && check.expiresOn < today) return false;
  if (check.method === "returning_client") {
    const decision = rules.returningDecision({
      checkedOn: check.originalCheckedOn || check.checkedOn,
      today,
      doubt: check.doubt,
      confirmedHigh: high,
    });
    return decision.offered;
  }
  if (check.doubt) return false;
  return true;
}

export async function recordInPerson(
  client: pg.PoolClient,
  actor: LedgerActor,
  input: {
    customerId: string;
    docType: string;
    number: string;
    issuerRegion: string;
    issuerCountry: string;
    expiresOn: string;
    faceMatched: boolean;
    looksGenuine: boolean;
  },
): Promise<{ check: ShopCheck; number: string; badge: string }> {
  const number = input.number.trim();
  const expiresOn = day(input.expiresOn);
  const today = civilToday();
  if (!input.customerId.trim() || !input.docType.trim() || number.length < 4 || number.length > 40) {
    throw new LedgerError("INVALID_REQUEST", "ID type, number, and customer are required.");
  }
  if (!input.issuerRegion.trim() || !input.issuerCountry.trim() || !expiresOn) {
    throw new LedgerError("INVALID_REQUEST", "Issuing region, country, and expiry are required.");
  }
  if (!input.faceMatched || !input.looksGenuine || expiresOn < today) {
    throw new LedgerError("ID_CHECK_REQUIRED", "The original photo ID has to look genuine, match the face, and not be expired.");
  }
  const checkId = `idc_${randomUUID()}`;
  const ciphertext = await encryptSecret(number);
  const last4 = number.slice(-4);
  await client.query(
    `INSERT INTO client_id_checks
       (check_id, tenant_id, legal_entity_id, customer_id, method, doc_type, number_ciphertext,
        number_last4, number_length, issuer_region, issuer_country, expires_on, checked_on,
        checked_by, lifts_lock, doubt)
     VALUES ($1,$2,$3,$4,'photo_id_in_person',$5,$6,$7,$8,$9,$10,$11,$12,$13,true,false)`,
    [
      checkId, actor.tenantId, actor.legalEntityId, input.customerId.trim(),
      input.docType.trim(), ciphertext, last4, number.length,
      input.issuerRegion.trim(), input.issuerCountry.trim(), expiresOn, today, actor.userId,
    ],
  );
  const check = (await loadShopCheck(client, actor.legalEntityId, input.customerId.trim()))!;
  return { check, number, badge: badgeFor(check) || "" };
}

export async function recordReturning(
  client: pg.PoolClient,
  actor: LedgerActor,
  customerId: string,
  doubt: boolean,
): Promise<{ offered: boolean; recommended: boolean; reason: string; badge: string | null }> {
  const today = civilToday();
  const existing = await loadShopCheck(client, actor.legalEntityId, customerId);
  const high = await confirmedHigh(client, actor.legalEntityId, customerId);
  const decision = rules.returningDecision({
    checkedOn: existing && existing.liftsLock ? (existing.originalCheckedOn || existing.checkedOn) : null,
    today,
    doubt: doubt || existing?.doubt === true,
    confirmedHigh: high,
  });
  if (!decision.offered || !existing) {
    return { offered: false, recommended: false, reason: decision.reason || rules.NO_EARLIER_CHECK, badge: null };
  }
  const checkId = `idc_${randomUUID()}`;
  await client.query(
    `INSERT INTO client_id_checks
       (check_id, tenant_id, legal_entity_id, customer_id, method, doc_type, number_last4, number_length,
        issuer_region, issuer_country, expires_on, checked_on, checked_by, lifts_lock, original_checked_on, doubt)
     VALUES ($1,$2,$3,$4,'returning_client',$5,$6,$7,$8,$9,$10,$11,$12,true,$13,false)`,
    [
      checkId, actor.tenantId, actor.legalEntityId, customerId,
      existing.docType, existing.last4, existing.numberLength,
      existing.issuerRegion, existing.issuerCountry, existing.expiresOn,
      today, actor.userId, existing.originalCheckedOn || existing.checkedOn,
    ],
  );
  const saved = await loadShopCheck(client, actor.legalEntityId, customerId);
  return { ...decision, badge: badgeFor(saved) };
}

export async function listRevealReasons(client: pg.PoolClient): Promise<RevealReason[]> {
  const found = await client.query(
    `SELECT code, label, requires_note, min_note_length, active
       FROM id_reveal_reasons
      WHERE active
      ORDER BY sort_order, code`,
  );
  return found.rows.map((row) => ({
    code: String(row.code),
    label: String(row.label),
    requiresNote: row.requires_note === true,
    minNoteLength: Number(row.min_note_length || 0),
    active: row.active !== false,
  }));
}

export async function revealNumber(
  client: pg.PoolClient,
  actor: LedgerActor,
  input: { customerId: string; checkId?: string | null; reasonCode: string; note?: string | null; action: "reveal" | "export" },
): Promise<{ number: string; reasonCode: string }> {
  if (!REVEAL_ROLES.has(actor.role)) {
    throw new LedgerError("AUTHORIZATION_DENIED", "You cannot reveal an ID number.");
  }
  const reasons = await listRevealReasons(client);
  const reason = reasons.find((item) => item.code === input.reasonCode.trim());
  if (!reason || !rules.revealNoteOk(reason, input.note || "")) {
    const min = reason?.minNoteLength ?? 0;
    throw new LedgerError(
      "INVALID_REQUEST",
      reason
        ? `That reason needs a note of at least ${min} characters.`
        : "That reason is not on the list.",
    );
  }
  const found = input.checkId
    ? await client.query(
        `SELECT check_id, number_ciphertext FROM client_id_checks
          WHERE check_id = $1 AND legal_entity_id = $2 AND customer_id = $3`,
        [input.checkId, actor.legalEntityId, input.customerId],
      )
    : await client.query(
        `SELECT check_id, number_ciphertext FROM client_id_checks
          WHERE legal_entity_id = $1 AND customer_id = $2 AND number_ciphertext IS NOT NULL
          ORDER BY checked_on DESC, created_at DESC
          LIMIT 1`,
        [actor.legalEntityId, input.customerId],
      );
  const row = found.rows[0];
  if (!row?.number_ciphertext) {
    throw new LedgerError("ID_CHECK_REQUIRED", "This shop has no ID number on file for that client.");
  }
  await client.query(
    `INSERT INTO id_number_access
       (access_id, tenant_id, legal_entity_id, customer_id, check_id, actor_id, actor_role, action, reason_code, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      `acc_${randomUUID()}`, actor.tenantId, actor.legalEntityId, input.customerId,
      String(row.check_id), actor.userId, actor.role, input.action, reason.code,
      input.note?.trim() || null,
    ],
  );
  return { number: await decryptSecret(String(row.number_ciphertext)), reasonCode: reason.code };
}
