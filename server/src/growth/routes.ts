import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit.js";
import { SESSION_COOKIE, resolveSessionState } from "../auth/sessions.js";
import { schema, type Db } from "../db/index.js";
import { can, member, type Permission, type PlatformRole } from "../platform/team.js";
import { CallRefused, placeOutboundCall, type OutboundCallConfig, type OutboundCallProvider } from "./calls.js";
import { elevenLabsRuntime, verifyElevenLabsWebhook, type ElevenLabsRuntime } from "./elevenlabs.js";
import { researchEnquiry, ResearchUnavailable, tavilyResearchProvider, type LeadResearchProvider } from "./research.js";

export type GrowthDependencies = {
  researchProvider?: LeadResearchProvider | null;
  callProvider?: OutboundCallProvider | null;
  callConfig?: OutboundCallConfig | null;
  webhookSecret?: string | null;
  toolSecret?: string | null;
  now?: () => Date;
};

type PlatformActor = {
  id: string;
  staffId: string;
  tenantId: string;
  legalEntityId: string;
  branchId: string;
  platformRole: PlatformRole;
};

const doNotContactBody = z.object({ doNotContact: z.literal(true), reason: z.string().trim().max(500).optional() });
const callingBody = z.object({ enabled: z.boolean() });
const toolBody = z.object({
  enquiryId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
});

const settingEnabled = async (db: Db): Promise<boolean> => {
  const setting = (await db.select().from(schema.platformSettings)
    .where(eq(schema.platformSettings.key, "outbound_calling_enabled")).limit(1))[0];
  return setting?.value?.enabled === true;
};

export function registerGrowthRoutes(app: FastifyInstance, db: Db, dependencies: GrowthDependencies = {}): void {
  const runtime: ElevenLabsRuntime | null = dependencies.callProvider === undefined
    ? elevenLabsRuntime()
    : dependencies.callProvider && dependencies.callConfig
      ? {
          provider: dependencies.callProvider,
          config: dependencies.callConfig,
          webhookSecret: dependencies.webhookSecret ?? null,
          toolSecret: dependencies.toolSecret ?? null,
        }
      : null;
  const researchProvider = dependencies.researchProvider === undefined
    ? tavilyResearchProvider()
    : dependencies.researchProvider;

  async function gate(req: FastifyRequest, reply: FastifyReply, need: Permission): Promise<PlatformActor | null> {
    const state = await resolveSessionState(db, req.cookies[SESSION_COOKIE]);
    if (state.state === "none") {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    const me = await member(db, state.user.staffId);
    if (!me) {
      reply.code(state.state === "suspended" ? 401 : 403).send({ error: state.state === "suspended" ? "unauthenticated" : "forbidden" });
      return null;
    }
    const role = me.role as PlatformRole;
    if (!can(role, need)) {
      reply.code(403).send({ error: "permission_denied", detail: `Your role (${role}) cannot ${need.replace(":", " ")}.` });
      return null;
    }
    return { ...state.user, platformRole: role };
  }

  app.get<{ Params: { id: string } }>("/api/admin/enquiries/:id/growth", async (req, reply) => {
    const who = await gate(req, reply, "applications:read");
    if (!who) return;
    const enquiry = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!enquiry) return reply.code(404).send({ error: "not_found" });
    const runs = await db.select().from(schema.enquiryResearchRuns)
      .where(eq(schema.enquiryResearchRuns.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryResearchRuns.runAt));
    const research = await Promise.all(runs.map(async (run) => ({
      ...run,
      facts: await db.select().from(schema.enquiryResearchFacts)
        .where(eq(schema.enquiryResearchFacts.researchId, run.id)),
      reviews: await db.select().from(schema.enquiryResearchReviews)
        .where(eq(schema.enquiryResearchReviews.researchId, run.id))
        .orderBy(schema.enquiryResearchReviews.reviewedAt),
    })));
    const calls = await db.select().from(schema.enquiryCalls)
      .where(eq(schema.enquiryCalls.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryCalls.requestedAt));
    const consent = (await db.select().from(schema.enquiryContactConsents)
      .where(eq(schema.enquiryContactConsents.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryContactConsents.consentedAt)).limit(1))[0];
    return {
      research,
      calls,
      consent: consent ? {
        consentedAt: consent.consentedAt,
        formVersion: consent.formVersion,
        timezone: consent.timezone,
        timezoneSource: consent.timezoneSource,
      } : null,
      doNotContact: enquiry.doNotContact,
      doNotContactAt: enquiry.doNotContactAt,
      doNotContactReason: enquiry.doNotContactReason,
      capabilities: {
        researchConfigured: !!researchProvider,
        callingConfigured: !!runtime,
        callingEnabled: await settingEnabled(db),
        canManageCalling: can(who.platformRole, "security:manage"),
      },
    };
  });

  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/research", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    if (!researchProvider) return reply.code(503).send({ error: "research_not_configured", detail: "Set TAVILY_API_KEY to enable lead research." });
    const enquiry = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!enquiry || enquiry.kind !== "early_access") return reply.code(404).send({ error: "not_found" });
    try {
      const runId = await researchEnquiry({ db, enquiry, createdBy: who.staffId, provider: researchProvider, now: dependencies.now });
      await audit(db, {
        tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id,
        action: "admin.enquiry_researched", detail: { enquiryId: enquiry.id, reference: enquiry.reference, runId },
      });
      return reply.code(201).send({ ok: true, runId });
    } catch (error) {
      if (error instanceof ResearchUnavailable) return reply.code(error.statusCode).send({ error: error.code, detail: error.message });
      throw error;
    }
  });

  app.post<{ Params: { id: string; runId: string } }>("/api/admin/enquiries/:id/research/:runId/review", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    const run = (await db.select().from(schema.enquiryResearchRuns).where(and(
      eq(schema.enquiryResearchRuns.id, req.params.runId),
      eq(schema.enquiryResearchRuns.enquiryId, req.params.id),
    )).limit(1))[0];
    if (!run) return reply.code(404).send({ error: "not_found" });
    const [review] = await db.insert(schema.enquiryResearchReviews).values({
      id: randomUUID(), researchId: run.id, reviewedBy: who.staffId,
    }).returning();
    return reply.code(201).send({ ok: true, review });
  });

  app.post<{ Params: { id: string } }>("/api/admin/enquiries/:id/call", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    if (!runtime) return reply.code(503).send({
      error: "calling_not_configured",
      detail: "Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID and ELEVENLABS_AGENT_PHONE_NUMBER_ID to enable calling.",
    });
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string") return reply.code(400).send({ error: "idempotency_required", detail: "Idempotency-Key is required." });
    try {
      const result = await placeOutboundCall({
        db, enquiryId: req.params.id, triggerKey: key, createdBy: who.staffId,
        provider: runtime.provider, config: runtime.config, now: dependencies.now,
      });
      await audit(db, {
        tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id,
        action: result.replayed ? "admin.enquiry_call_replayed" : "admin.enquiry_call_placed",
        detail: { enquiryId: req.params.id, callId: result.call.id, conversationId: result.call.conversationId },
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      if (error instanceof CallRefused) return reply.code(error.statusCode).send({ error: error.code, detail: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/admin/enquiries/:id/contact", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    const parsed = doNotContactBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Do-not-contact may only be set, never cleared automatically." });
    const changed = await db.update(schema.enquiries).set({
      doNotContact: true,
      doNotContactAt: new Date(),
      doNotContactBy: who.staffId,
      doNotContactReason: parsed.data.reason ?? "operator",
    }).where(eq(schema.enquiries.id, req.params.id)).returning();
    if (!changed[0]) return reply.code(404).send({ error: "not_found" });
    return { ok: true, doNotContact: true };
  });

  app.patch("/api/admin/growth/calling", async (req, reply) => {
    const who = await gate(req, reply, "security:manage");
    if (!who) return;
    const parsed = callingBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    await db.insert(schema.platformSettings).values({
      key: "outbound_calling_enabled",
      value: { enabled: parsed.data.enabled },
      updatedBy: who.staffId,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: schema.platformSettings.key,
      set: { value: { enabled: parsed.data.enabled }, updatedBy: who.staffId, updatedAt: new Date() },
    });
    return { ok: true, enabled: parsed.data.enabled };
  });

  app.post("/api/webhooks/elevenlabs", { config: { rawBody: true } }, async (req, reply) => {
    if (!runtime?.webhookSecret || !req.rawBody) return reply.code(503).send({ error: "webhook_not_configured" });
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
    const signature = req.headers["elevenlabs-signature"];
    if (typeof signature !== "string" || !verifyElevenLabsWebhook({
      rawBody, signature, secret: runtime.webhookSecret,
    })) return reply.code(401).send({ error: "invalid_signature" });
    const event = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : null;
    if (!conversationId) return { ok: true, ignored: true };
    const call = (await db.select().from(schema.enquiryCalls)
      .where(eq(schema.enquiryCalls.conversationId, conversationId)).limit(1))[0];
    if (!call) return { ok: true, ignored: true };

    const analysis = data.analysis && typeof data.analysis === "object" ? data.analysis as Record<string, unknown> : {};
    const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata as Record<string, unknown> : {};
    const transcript = Array.isArray(data.transcript) ? data.transcript : null;
    const type = typeof event.type === "string" ? event.type : "unknown";
    const outcome = type === "call_initiation_failure"
      ? String(data.failure_reason ?? "failed")
      : analysis.call_successful == null ? "completed" : String(analysis.call_successful);
    const durationValue = Number(metadata.call_duration_secs ?? metadata.duration_seconds);
    await db.update(schema.enquiryCalls).set({
      status: type === "call_initiation_failure" ? "failed" : "completed",
      completedAt: new Date(),
      durationSeconds: Number.isFinite(durationValue) && durationValue >= 0 ? Math.round(durationValue) : null,
      outcome,
      recordingUrl: typeof data.recording_url === "string" ? data.recording_url : null,
      transcript,
      summary: typeof analysis.transcript_summary === "string" ? analysis.transcript_summary.slice(0, 20_000) : null,
      error: type === "call_initiation_failure" ? outcome : null,
    }).where(eq(schema.enquiryCalls.id, call.id));
    return { ok: true };
  });

  /* The voice agent invokes this tool the moment somebody says stop. It is
     tied to an existing conversation and protected by its own secret, so a
     guessed enquiry id cannot silence a lead. */
  app.post("/api/webhooks/elevenlabs/do-not-contact", async (req, reply) => {
    if (!runtime?.toolSecret) return reply.code(503).send({ error: "tool_not_configured" });
    if (req.headers.authorization !== `Bearer ${runtime.toolSecret}`) return reply.code(401).send({ error: "unauthorized" });
    const parsed = toolBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const call = (await db.select().from(schema.enquiryCalls).where(and(
      eq(schema.enquiryCalls.enquiryId, parsed.data.enquiryId),
      eq(schema.enquiryCalls.conversationId, parsed.data.conversationId),
    )).limit(1))[0];
    if (!call) return reply.code(404).send({ error: "call_not_found" });
    await db.update(schema.enquiries).set({
      doNotContact: true,
      doNotContactAt: new Date(),
      doNotContactBy: `elevenlabs:${parsed.data.conversationId}`,
      doNotContactReason: parsed.data.reason ?? "requested during call",
    }).where(eq(schema.enquiries.id, parsed.data.enquiryId));
    return { ok: true, doNotContact: true };
  });
}
