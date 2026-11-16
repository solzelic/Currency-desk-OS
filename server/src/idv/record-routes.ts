/* Consent, in-person and returning checks, the one-time link, the masked
   read, the number reveal, and the face-crop view. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasBackendPermission } from "../auth/permissions.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { isStagingRuntime } from "../auth/staging-runtime.js";
import type { Db } from "../db/index.js";
import { CONSENT_VERSION, noticeCopy, privacyReady, selfieConsentCopy } from "./consent-copy.js";
import { generateOneTimeLink } from "./persona-calls.js";
import { personaApiKey } from "./providers/persona.js";
import type { IdvRouteOptions } from "./registry.js";
import {
  agreedConsent, consentFill, dbQuery, linkRecordDeal, loadShopIdv, readClientChecks, recordInPerson,
  recordReturning, revealNumber, storeConsent, supersedeRecord, viewFaceCrop, type DeskActor,
} from "./records.js";
import { shopEnvCodeFor } from "./shop-config.js";
import { counterOnly } from "./tiers.js";

const CLIENT_ID = z.string().trim().min(1).max(80);

function actorOf(who: { tenantId: string; legalEntityId: string; branchId: string; staffId: string; role: DeskActor["role"]; id: string }): DeskActor {
  return {
    tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId,
    staffId: who.staffId, role: who.role, userId: who.id,
  };
}

export function registerIdvRecordRoutes(app: FastifyInstance, db: Db, options?: IdvRouteOptions): void {
  const env = () => options?.env ?? process.env;

  async function who(req: { cookies: Record<string, string | undefined> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const session = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (!hasBackendPermission(session.role, "customer:view")) {
      reply.code(403).send({ error: "forbidden", message: "You cannot open this ID check." });
      return null;
    }
    return actorOf(session);
  }

  app.get("/api/idv/consent-copy", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    const fill = await consentFill(db, actor);
    return {
      version: CONSENT_VERSION,
      faceCrop: fill.faceCrop,
      notice: noticeCopy(fill),
      selfieConsent: selfieConsentCopy(fill),
    };
  });

  app.post("/api/idv/consents", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({
      clientId: CLIENT_ID,
      choice: z.enum(["agreed", "counter_check"]),
      language: z.string().trim().min(2).max(8),
      inquiryId: z.string().trim().min(1).max(80).nullable().optional(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const saved = await storeConsent(db, actor, {
      clientId: body.data.clientId, choice: body.data.choice, language: body.data.language,
      inquiryId: body.data.inquiryId ?? null,
    });
    if (!saved.ok) return reply.code(saved.status).send({ error: saved.error, message: saved.message });
    return saved.body;
  });

  app.post("/api/idv/checks/in-person", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({
      clientId: CLIENT_ID,
      nameOnId: z.string().trim().min(1).max(200),
      documentType: z.string().trim().min(1).max(80),
      documentNumber: z.string().trim().min(1).max(40),
      issuingJurisdiction: z.string().trim().min(1).max(80),
      issuingCountry: z.string().trim().min(2).max(80),
      expiryDate: z.string().trim().optional(),
      attested: z.boolean(),
      dealId: z.string().trim().min(1).max(80).optional(),
      address: z.string().trim().max(300).optional(),
      dateOfBirth: z.string().trim().optional(),
      consentId: z.string().trim().max(80).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const saved = await recordInPerson(db, actor, body.data, env());
    if (!saved.ok) return reply.code(saved.status).send({ error: saved.error, message: saved.message });
    return saved.body;
  });

  app.post("/api/idv/checks/returning", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({
      clientId: CLIENT_ID,
      noDoubts: z.boolean(),
      detailsChanged: z.boolean(),
      doubtReason: z.string().trim().max(500).optional(),
      dealId: z.string().trim().min(1).max(80).optional(),
      pepAnswer: z.boolean(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const saved = await recordReturning(db, actor, body.data);
    if (!saved.ok) return reply.code(saved.status).send({ error: saved.error, message: saved.message });
    return saved.body;
  });

  app.post<{ Params: { inquiryId: string } }>("/api/idv/inquiries/:inquiryId/one-time-link", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const inquiryId = req.params.inquiryId.trim();
    if (!inquiryId || inquiryId.length > 80) return reply.code(400).send({ error: "invalid_request" });
    const branch = await dbQuery(db).query(
      "SELECT province FROM branches WHERE id = $1 AND legal_entity_id = $2",
      [actor.branchId, actor.legalEntityId],
    );
    const gate = counterOnly(branch.rows[0] ? String(branch.rows[0].province ?? "") : null);
    if (gate.counter) return reply.code(409).send({ code: "COUNTER_ONLY", message: gate.line });
    if (!await agreedConsent(db, actor, inquiryId)) {
      return reply.code(409).send({ error: "consent_required", message: "Record consent before the ID check link opens." });
    }
    const fill = await consentFill(db, actor);
    if (isStagingRuntime(undefined, env()) && !privacyReady(fill)) {
      return reply.code(409).send({
        code: "PRIVACY_CONTACT",
        message: "Set the shop privacy contact before a face match. The owner adds it in identity check settings.",
      });
    }
    const shop = await loadShopIdv(db, actor.legalEntityId);
    const key = personaApiKey({ apiKeyRef: shop.apiKeyRef, shopCode: await shopEnvCodeFor(db, actor.tenantId) }, env());
    if (!key) return reply.code(409).send({ code: "IDV_KEY", message: "Identity checks are not connected." });
    try {
      const url = await generateOneTimeLink({ inquiryId, key, env: env(), fetchImpl: options?.fetch });
      return { url };
    } catch {
      return reply.code(502).send({ error: "link_failed", message: "The ID check link could not be opened." });
    }
  });

  app.get<{ Params: { clientId: string } }>("/api/idv/clients/:clientId/checks", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    const read = await readClientChecks(db, actor, req.params.clientId.trim(), env());
    if (!read.ok) return reply.code(read.status).send({ error: read.error, message: read.message });
    return read.body;
  });

  app.post<{ Params: { recordId: string } }>("/api/idv/checks/:recordId/reveal", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    const body = z.object({
      reason: z.string().trim().min(1).max(40),
      note: z.string().trim().max(500).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "Pick a reason for revealing the document number." });
    const shown = await revealNumber(db, actor, req.params.recordId, body.data.reason, body.data.note, env());
    if (!shown.ok) return reply.code(shown.status).send({ error: shown.error, message: shown.message });
    return shown.body;
  });

  app.post<{ Params: { recordId: string } }>("/api/idv/checks/:recordId/face", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    const body = z.object({
      reason: z.string().trim().min(1).max(40),
      note: z.string().trim().max(500).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", message: "The photo is shown for comparison by eye only." });
    const shown = await viewFaceCrop(db, actor, req.params.recordId, body.data.reason, body.data.note, env());
    if (!shown.ok) return reply.code(shown.status).send({ error: shown.error, message: shown.message });
    return shown.body;
  });

  app.post<{ Params: { recordId: string } }>("/api/idv/checks/:recordId/supersede", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ replacedByRecordId: z.string().trim().min(1).max(80) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const saved = await supersedeRecord(db, actor, req.params.recordId, body.data.replacedByRecordId);
    if (!saved.ok) return reply.code(saved.status).send({ error: saved.error, message: saved.message });
    return saved.body;
  });

  app.post<{ Params: { recordId: string } }>("/api/idv/checks/:recordId/deal", async (req, reply) => {
    const actor = await who(req, reply);
    if (!actor) return;
    if (!hasBackendPermission(actor.role, "customer:write")) return reply.code(403).send({ error: "forbidden" });
    const body = z.object({ dealId: z.string().trim().min(1).max(80) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    const saved = await linkRecordDeal(db, actor, req.params.recordId, body.data.dealId);
    if (!saved.ok) return reply.code(saved.status).send({ error: saved.error, message: saved.message });
    return saved.body;
  });
}
