/* ============================================================
   The customer file, over HTTP.

   Scope resolution is deliberately a copy of the ledger's rather than a
   shared helper: `registerLedgerRoutes` owns its own pool and its own
   resolution, and reaching into it from here would couple two route
   files that have no other reason to know about each other. What must
   NOT differ is the rule, and the rule is the same one in both places —
   tenant, entity and branch come from the SESSION and can never be named
   by the request; the workspace may be named, and only from the ones
   this session's branch actually has.

   The permission is `customer:view` / `customer:write`, the same pair
   the ledger's own customer routes use. Viewing an identity document is
   NOT a separate permission, and that is a decision rather than an
   omission: anybody who can open a client file can already see the
   document, so a permission would be theatre. What the desk gets instead
   is a record that it happened. See the header of records.ts.
   ============================================================ */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { tenantPlan } from "../routes/tenant.js";
import { ensureLedgerPrincipal } from "../ledger/principal.js";
import { LedgerError, type LedgerActor } from "../ledger/service.js";
import { isRetryable } from "../ledger/retry.js";
import { ClientRecordService } from "./records.js";

/* An ISO calendar day or nothing. Deliberately not `z.coerce.date()`:
   "1985-13-45" is not a date and a customer record is not the place to
   find that out three years later. */
const calendarDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(value)), "That is not a real date.");

const nullableDay = z.union([calendarDay, z.literal("")]).nullable().optional();
const text = (max: number) => z.string().trim().max(max).nullable().optional();

const clientBody = z.object({
  kind: z.enum(["individual", "business"]).default("individual"),
  legalName: z.string().trim().min(1).max(300),
  dateOfBirth: nullableDay,
  addressLine: text(400),
  city: text(200),
  region: text(200),
  postalCode: text(40),
  country: text(120),
  email: text(320),
  phone: text(60),
  occupation: text(200),
  notes: text(4000),
  riskRating: z.enum(["low", "normal", "medium", "high"]).default("normal"),
  verificationStatus: z
    .enum(["unverified", "identified", "verified", "expired"])
    .default("unverified"),
  screeningOutcome: z.enum(["clear", "hit", "pending"]).nullable().optional(),
  screeningMatched: text(600),
  incorporationDate: nullableDay,
  incorporationJurisdiction: text(200),
  natureOfBusiness: text(400),
  contactName: text(200),
  contactTitle: text(200),
}).strict();

/* Every field optional on a change, and at least one required. A PATCH
   that carried the whole record would let a stale screen quietly undo
   somebody else's edit to a field it was not even showing — the same
   reasoning as the desk-thresholds body in ledger/routes.ts. */
const clientChanges = clientBody.partial().strict().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "Name at least one field to change." },
);

/* A scan, as the browser's intake produces it. The size bound here is
   the transport's; the service applies its own and explains it. */
const scanDataUrl = z
  .string()
  .max(8 * 1024 * 1024)
  .regex(/^data:[a-z0-9.+/-]+;base64,/i, "A scan arrives as a base64 data URL.");

const documentBody = z.object({
  docType: z.string().trim().min(1).max(120),
  docNumber: text(200),
  issuingJurisdiction: text(200),
  issuedOn: nullableDay,
  expiresOn: nullableDay,
  isPrimary: z.boolean().optional(),
  scanDataUrl: scanDataUrl.nullable().optional(),
}).strict();

const documentChanges = documentBody.partial().strict().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  { message: "Name at least one field to change." },
);

const photographBody = z.object({ dataUrl: scanDataUrl }).strict();
const aliasBody = z.object({ alias: z.string().trim().min(1).max(300) }).strict();
const revealBody = z.object({ purpose: z.string().trim().max(200).optional() }).strict();
const lookupQuery = z.object({ name: z.string().trim().min(1).max(300) });
const disclosureQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

type Resolution =
  | { kind: "authenticated"; actor: LedgerActor }
  | { kind: "unauthenticated" }
  | { kind: "scope_denied" }
  | { kind: "plan_denied" };

export function registerClientRoutes(app: FastifyInstance, db: Db, databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const records = new ClientRecordService(pool);
  app.addHook("onClose", async () => { await pool.end(); });

  async function resolveActor(req: FastifyRequest): Promise<Resolution> {
    const user = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return { kind: "unauthenticated" };
    if ((await tenantPlan(db, user.tenantId)) === "basic") return { kind: "plan_denied" };
    const header = req.headers["x-workspace-id"];
    if (Array.isArray(header)) return { kind: "scope_denied" };
    const candidates = await db.select().from(schema.workspaces).where(and(
      eq(schema.workspaces.tenantId, user.tenantId),
      eq(schema.workspaces.legalEntityId, user.legalEntityId),
      eq(schema.workspaces.branchId, user.branchId),
    ));
    const workspace = header
      ? candidates.find((item) => item.id === header)
      : candidates.length === 1 ? candidates[0] : undefined;
    if (!workspace || !user.authorizedBranchIds.includes(workspace.branchId))
      return { kind: "scope_denied" };
    const actor: LedgerActor = {
      userId: user.id,
      tenantId: user.tenantId,
      legalEntityId: user.legalEntityId,
      branchId: workspace.branchId,
      workspaceId: workspace.id,
      tillId: workspace.tillId,
      role: user.role,
      authorizedBranchIds: user.authorizedBranchIds,
    };
    await ensureLedgerPrincipal(pool, actor);
    return { kind: "authenticated", actor };
  }

  type Reply = { code(status: number): { send(value: unknown): unknown } };

  async function actorOrReply(req: FastifyRequest, reply: Reply): Promise<LedgerActor | null> {
    const current = await resolveActor(req);
    if (current.kind === "unauthenticated") {
      reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return null;
    }
    if (current.kind === "plan_denied") {
      reply.code(403).send({
        code: "PLAN_NOT_ENTITLED",
        message: "Server-held customer records are a Pro feature — upgrade the plan to use them.",
      });
      return null;
    }
    if (current.kind === "scope_denied") {
      reply.code(403).send({ code: "SCOPE_DENIED" });
      return null;
    }
    return current.actor;
  }

  function failure(reply: Reply, error: unknown) {
    if (isRetryable(error)) {
      app.log.warn(error, "client records contention after retries");
      return reply.code(409).send({
        code: "LEDGER_BUSY",
        message: "Another change to this customer is being recorded. Nothing was saved — try again.",
      });
    }
    if (!(error instanceof LedgerError)) {
      app.log.error(error, "client records route failure");
      return reply.code(500).send({ code: "INTERNAL_ERROR", message: "Unexpected server error." });
    }
    const status =
      error.code === "AUTHENTICATION_REQUIRED" ? 401
        : error.code === "AUTHORIZATION_DENIED" || error.code === "SCOPE_DENIED" ? 403
          : error.code === "CLIENT_NOT_FOUND" ||
              error.code === "CLIENT_DOCUMENT_NOT_FOUND" ||
              error.code === "SCAN_NOT_ON_FILE" ||
              error.code === "PHOTOGRAPH_NOT_ON_FILE" ? 404
            : error.code === "SCAN_TOO_LARGE" ? 413
              : 422;
    return reply.code(status).send({ code: error.code, message: error.message });
  }

  /* A bad body is a 422 with the field named. Zod's message is the most
     useful thing anybody gets here and throwing it away for "invalid
     request" is how a teller ends up guessing. */
  const invalid = (reply: Reply, error: z.ZodError) =>
    reply.code(422).send({
      code: "INVALID_REQUEST",
      message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    });

  app.get("/api/clients", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      return actor ? reply.send(await records.list(actor)) : undefined;
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* Registered before "/api/clients/:clientId" so that "lookup" is not
     read as an id. Fastify's radix router prefers the static segment
     either way; the order is here for the reader, not the router. */
  app.get("/api/clients/lookup", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const query = lookupQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, query.error);
      return reply.send(await records.lookupByName(actor, query.data.name));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/clients", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = clientBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      return reply.code(201).send(await records.create(actor, body.data));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/clients/:clientId", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.get(actor, clientId));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.patch("/api/clients/:clientId", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = clientChanges.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.update(actor, clientId, body.data));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/clients/:clientId/aliases", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = aliasBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.addAlias(actor, clientId, body.data.alias));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post("/api/clients/:clientId/documents", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = documentBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const { clientId } = req.params as { clientId: string };
      return reply.code(201).send(await records.addDocument(actor, clientId, body.data));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.patch("/api/clients/:clientId/documents/:documentId", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = documentChanges.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const { clientId, documentId } = req.params as { clientId: string; documentId: string };
      return reply.send(await records.updateDocument(actor, clientId, documentId, body.data));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete("/api/clients/:clientId/documents/:documentId", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const { clientId, documentId } = req.params as { clientId: string; documentId: string };
      return reply.send(await records.removeDocument(actor, clientId, documentId));
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* THE AUDITED REVEAL.

     A POST rather than a GET, and not for REST tidiness. This request
     writes a durable record every time it is made, which is precisely
     what a GET promises not to do — and a GET is what a browser
     prefetches, a proxy caches and a crawler follows. "Who looked at
     this customer's passport" must not have the answer "the cache did,
     forty times". */
  app.post("/api/clients/:clientId/documents/:documentId/reveal", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = revealBody.safeParse(req.body ?? {});
      if (!body.success) return invalid(reply, body.error);
      const { clientId, documentId } = req.params as { clientId: string; documentId: string };
      reply.header("cache-control", "no-store");
      return reply.send(
        await records.revealDocumentScan(actor, clientId, documentId, body.data.purpose),
      );
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.delete("/api/clients/:clientId/documents/:documentId/scan", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const { clientId, documentId } = req.params as { clientId: string; documentId: string };
      return reply.send(await records.removeDocumentScan(actor, clientId, documentId));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/clients/:clientId/disclosures", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const query = disclosureQuery.safeParse(req.query);
      if (!query.success) return invalid(reply, query.error);
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.disclosures(actor, clientId, query.data.limit));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.put("/api/clients/:clientId/photograph", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const body = photographBody.safeParse(req.body);
      if (!body.success) return invalid(reply, body.error);
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.setPhotograph(actor, clientId, body.data.dataUrl));
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get("/api/clients/:clientId/photograph", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const { clientId } = req.params as { clientId: string };
      reply.header("cache-control", "no-store");
      return reply.send(await records.photograph(actor, clientId));
    } catch (error) {
      return failure(reply, error);
    }
  });

  /* This customer, as the till's own counter record — the `customerId`
     the posting path wants. The join between the desk's file and the
     ledger's row, made explicit so a caller never has to guess it. */
  app.post("/api/clients/:clientId/counter-record", async (req, reply) => {
    try {
      const actor = await actorOrReply(req, reply);
      if (!actor) return undefined;
      const { clientId } = req.params as { clientId: string };
      return reply.send(await records.counterRecord(actor, clientId));
    } catch (error) {
      return failure(reply, error);
    }
  });
}
