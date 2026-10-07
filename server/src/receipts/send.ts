/* Email a posted receipt. The deal is already on the ledger.
   This function never writes a ledger row. A failed send does not
   change the client's saved email. */
import type pg from "pg";
import { z } from "zod";
import type { Db } from "../db/index.js";
import type { LedgerActor } from "../ledger/service.js";
import { audit } from "../audit.js";
import { emailTransportConfigured, sendEmail, type EmailStatus } from "../email.js";
import { loadReceiptIdentity, readReceiptOptions } from "./settings.js";
import { qrFor, receiptHtml, receiptText, receiptView, type LedgerReceiptFields } from "./document.js";
import { receiptPdf } from "./pdf.js";

const emailBody = z.object({
  to: z.string().trim().email().max(200),
  saveToClient: z.boolean().optional(),
}).strict();

export function parseReceiptEmailBody(body: unknown): { to: string; saveToClient: boolean } {
  const parsed = emailBody.safeParse(body);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Enter an email address.");
  }
  return { to: parsed.data.to, saveToClient: parsed.data.saveToClient === true };
}

const hits = new Map<string, number[]>();

export function resetReceiptEmailLimitsForTests() {
  hits.clear();
}

function allow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export interface DeliverInput {
  db: Db;
  pool: pg.Pool;
  actor: LedgerActor;
  receipt: LedgerReceiptFields & { transactionId?: string };
  to: string;
  saveToClient: boolean;
  origin: string;
}

export type DeliverResult =
  | { ok: true; status: EmailStatus; saved: boolean; detail: string }
  | { ok: false; status: number; error: string; message: string };

async function remember(db: Db, actor: LedgerActor, detail: Record<string, unknown>) {
  await audit(db, {
    tenantId: actor.tenantId,
    legalEntityId: actor.legalEntityId,
    branchId: actor.branchId,
    actorId: actor.userId,
    action: "receipt.email",
    detail,
  });
}

export async function deliverReceiptEmail(input: DeliverInput): Promise<DeliverResult> {
  const { db, pool, actor, receipt, to, saveToClient, origin } = input;
  if (!emailTransportConfigured()) {
    return {
      ok: false,
      status: 503,
      error: "email_not_configured",
      message: "Receipt email is not set up on this desk. Nothing was sent.",
    };
  }
  const deskKey = `desk:${actor.tenantId}`;
  const toKey = `to:${actor.tenantId}:${to.toLowerCase()}`;
  if (!allow(deskKey, 20, 60 * 60 * 1000) || !allow(toKey, 5, 10 * 60 * 1000)) {
    await remember(db, actor, {
      transactionRef: receipt.transactionRef,
      to,
      status: "refused",
    });
    return {
      ok: false,
      status: 429,
      error: "slow_down",
      message: "Too many receipt emails. Wait and try again. The deal is unchanged.",
    };
  }

  const options = await readReceiptOptions(db, actor.tenantId);
  const identity = await loadReceiptIdentity(db, {
    id: actor.userId,
    tenantId: actor.tenantId,
    legalEntityId: actor.legalEntityId,
    branchId: actor.branchId,
  }, origin);
  const qr = await qrFor(identity.rateUrl);
  const view = receiptView(receipt, options, identity, qr);
  const text = receiptText(view);
  const html = receiptHtml(view);
  const pdf = receiptPdf(text);
  const status = await sendEmail(to, `Receipt ${receipt.transactionRef}`, {
    text,
    html,
    fromName: identity.shopName,
    replyTo: identity.shopEmail ?? undefined,
    attachments: [{ filename: `receipt-${receipt.transactionRef}.pdf`, contentBase64: pdf.toString("base64") }],
  });

  await remember(db, actor, {
    transactionRef: receipt.transactionRef,
    to,
    status,
  });

  if (status !== "sent") {
    return {
      ok: false,
      status: 502,
      error: "email_failed",
      message: "The receipt email did not send. The deal is unchanged.",
    };
  }

  let saved = false;
  let detail = "Sent.";
  if (saveToClient) {
    const clientId = await clientIdFor(pool, actor, receipt);
    if (!clientId) {
      detail = "Sent. No client file is linked to this deal, so the address was not saved.";
    } else {
      await pool.query(
        `UPDATE desk_clients SET email = $1
          WHERE client_id = $2 AND tenant_id = $3 AND legal_entity_id = $4`,
        [to, clientId, actor.tenantId, actor.legalEntityId],
      );
      saved = true;
      detail = "Sent. The address is saved on the client.";
    }
  }
  return { ok: true, status, saved, detail };
}

async function clientIdFor(pool: pg.Pool, actor: LedgerActor, receipt: LedgerReceiptFields & { transactionId?: string }): Promise<string | null> {
  if (!receipt.transactionId) return null;
  const found = await pool.query(
    `SELECT c.client_id
       FROM ledger_transactions t
       JOIN ledger_customers c ON c.customer_id = t.customer_id
      WHERE t.transaction_id = $1 AND t.tenant_id = $2
        AND t.legal_entity_id = $3`,
    [receipt.transactionId, actor.tenantId, actor.legalEntityId],
  );
  const id = found.rows[0]?.client_id;
  return typeof id === "string" && id ? id : null;
}
