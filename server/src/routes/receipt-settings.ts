/* GET  /api/desk/receipt-settings   any signed-in teller
   PUT  /api/desk/receipt-settings   administrator only

   Printing needs the options. Changing them is the owner's job.
   A teller who can write the tenant state blob still cannot write these. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { emailTransportConfigured } from "../email.js";
import { PRINTER_HELP } from "../receipts/printer-help.js";
import {
  loadReceiptIdentity,
  parseReceiptPatch,
  readReceiptOptions,
  receiptPayload,
  writeReceiptOptions,
} from "../receipts/settings.js";
import { qrFor } from "../receipts/document.js";

function originOf(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (typeof forwarded === "string" ? forwarded.split(",")[0] : "http")?.trim() || "http";
  const host = req.headers.host || "localhost";
  return `${proto}://${host}`;
}

export function registerReceiptSettingsRoutes(app: FastifyInstance, db: Db) {
  app.get("/api/desk/receipt-settings", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const options = await readReceiptOptions(db, who.tenantId);
    const identity = await loadReceiptIdentity(db, who, originOf(req));
    const qrDataUrl = await qrFor(identity.rateUrl);
    return {
      ...receiptPayload(options, identity, emailTransportConfigured(), qrDataUrl),
      printerHelp: PRINTER_HELP,
    };
  });

  app.put("/api/desk/receipt-settings", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (who.role !== "administrator") {
      return reply.code(403).send({
        error: "permission_denied",
        message: "Receipt setup is the owner's decision. An administrator has to change it.",
      });
    }
    let patch;
    try {
      patch = parseReceiptPatch(req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Check the receipt settings.";
      return reply.code(400).send({ error: "invalid_request", message });
    }
    const options = await writeReceiptOptions(db, who.tenantId, patch);
    const identity = await loadReceiptIdentity(db, who, originOf(req));
    const qrDataUrl = await qrFor(identity.rateUrl);
    return {
      ...receiptPayload(options, identity, emailTransportConfigured(), qrDataUrl),
      printerHelp: PRINTER_HELP,
    };
  });
}
