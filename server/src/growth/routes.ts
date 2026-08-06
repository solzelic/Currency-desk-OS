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
import { growthWorkflow } from "./workflow.js";
import { startResearchWorker } from "./worker.js";

export type GrowthDependencies = {
  researchProvider?: LeadResearchProvider | null;
  callProvider?: OutboundCallProvider | null;
  callConfig?: OutboundCallConfig | null;
  webhookSecret?: string | null;
  toolSecret?: string | null;
  now?: () => Date;
  autoResearch?: boolean;
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
const assignmentBody = z.object({ assignedTo: z.string().trim().toLowerCase().max(200).nullable() });
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
  let stopWorker: (() => void) | null = null;
  const autoResearch = dependencies.autoResearch ?? process.env.NODE_ENV !== "test";
  if (researchProvider && autoResearch) {
    app.addHook("onReady", async () => { stopWorker = startResearchWorker({ db, provider: researchProvider, now: dependencies.now }); });
    app.addHook("onClose", async () => { stopWorker?.(); stopWorker = null; });
  }
  const visibleWorkflow = (input: Parameters<typeof growthWorkflow>[0]) => {
    const workflow = growthWorkflow(input);
    return !researchProvider && workflow.stage === "research_queued"
      ? { ...workflow, stage: "research_waiting_config", label: "Research waiting", nextAction: "Configure Tavily to start automatic research", tone: "amber" as const }
      : workflow;
  };

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
    const jobs = await db.select().from(schema.enquiryGrowthJobs)
      .where(eq(schema.enquiryGrowthJobs.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryGrowthJobs.createdAt));
    const timeline = await db.select().from(schema.enquiryGrowthEvents)
      .where(eq(schema.enquiryGrowthEvents.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryGrowthEvents.createdAt));
    const assignment = (await db.select().from(schema.enquiryGrowthAssignments)
      .where(eq(schema.enquiryGrowthAssignments.enquiryId, enquiry.id))
      .orderBy(desc(schema.enquiryGrowthAssignments.assignedAt)).limit(1))[0] ?? null;
    const assignableMembers = (await db.select().from(schema.platformUsers))
      .filter((person) => person.status === "active" && can(person.role as PlatformRole, "applications:write"))
      .map((person) => ({ email: person.email, name: person.name, role: person.role }));
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
      jobs,
      timeline,
      assignment,
      assignableMembers,
      workflow: visibleWorkflow({ enquiry, jobs, research, calls }),
      capabilities: {
        researchConfigured: !!researchProvider,
        callingConfigured: !!runtime,
        callingEnabled: await settingEnabled(db),
        canManageCalling: can(who.platformRole, "security:manage"),
        canWrite: can(who.platformRole, "applications:write"),
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
      await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: enquiry.id, type: "research_started", detail: { manual: true }, actor: who.staffId });
      const runId = await researchEnquiry({ db, enquiry, createdBy: who.staffId, provider: researchProvider, now: dependencies.now });
      const completedAt = dependencies.now?.() ?? new Date();
      await db.update(schema.enquiryGrowthJobs).set({ status: "completed", researchId: runId, completedAt, updatedAt: completedAt })
        .where(and(eq(schema.enquiryGrowthJobs.enquiryId, enquiry.id), eq(schema.enquiryGrowthJobs.status, "queued")));
      await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: enquiry.id, type: "research_completed", detail: { runId, manual: true }, actor: who.staffId });
      await audit(db, {
        tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id,
        action: "admin.enquiry_researched", detail: { enquiryId: enquiry.id, reference: enquiry.reference, runId },
      });
      return reply.code(201).send({ ok: true, runId });
    } catch (error) {
      if (error instanceof ResearchUnavailable) {
        await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: enquiry.id, type: "research_failed", detail: { manual: true, error: error.message }, actor: who.staffId });
        return reply.code(error.statusCode).send({ error: error.code, detail: error.message });
      }
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
    await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: req.params.id, type: "research_reviewed", detail: { runId: run.id }, actor: who.staffId });
    return reply.code(201).send({ ok: true, review });
  });

  app.patch<{ Params: { id: string } }>("/api/admin/enquiries/:id/growth/assignment", async (req, reply) => {
    const who = await gate(req, reply, "applications:write");
    if (!who) return;
    const parsed = assignmentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Choose a current application team member or leave it unassigned." });
    const enquiry = (await db.select().from(schema.enquiries).where(eq(schema.enquiries.id, req.params.id)).limit(1))[0];
    if (!enquiry || enquiry.kind !== "early_access") return reply.code(404).send({ error: "not_found" });
    if (parsed.data.assignedTo) {
      const person = (await db.select().from(schema.platformUsers).where(eq(schema.platformUsers.email, parsed.data.assignedTo)).limit(1))[0];
      if (!person || person.status !== "active" || !can(person.role as PlatformRole, "applications:write")) {
        return reply.code(400).send({ error: "invalid_assignee", detail: "That person is not an active application team member." });
      }
    }
    const [assignment] = await db.insert(schema.enquiryGrowthAssignments).values({
      id: randomUUID(), enquiryId: enquiry.id, assignedTo: parsed.data.assignedTo, assignedBy: who.staffId,
    }).returning();
    await db.insert(schema.enquiryGrowthEvents).values({
      id: randomUUID(), enquiryId: enquiry.id, type: parsed.data.assignedTo ? "owner_assigned" : "owner_cleared",
      detail: { assignedTo: parsed.data.assignedTo }, actor: who.staffId,
    });
    return { ok: true, assignment };
  });

  app.get("/api/admin/growth/pipeline", async (req, reply) => {
    const who = await gate(req, reply, "applications:read");
    if (!who) return;
    const enquiries = (await db.select().from(schema.enquiries)).filter((row) => row.kind === "early_access" && !row.isDemo);
    const byEnquiry: Record<string, unknown> = {};
    const counts: Record<string, number> = {};
    await Promise.all(enquiries.map(async (enquiry) => {
      const [jobs, runs, calls, assignmentRows] = await Promise.all([
        db.select().from(schema.enquiryGrowthJobs).where(eq(schema.enquiryGrowthJobs.enquiryId, enquiry.id)).orderBy(desc(schema.enquiryGrowthJobs.createdAt)),
        db.select().from(schema.enquiryResearchRuns).where(eq(schema.enquiryResearchRuns.enquiryId, enquiry.id)).orderBy(desc(schema.enquiryResearchRuns.runAt)),
        db.select().from(schema.enquiryCalls).where(eq(schema.enquiryCalls.enquiryId, enquiry.id)).orderBy(desc(schema.enquiryCalls.requestedAt)),
        db.select().from(schema.enquiryGrowthAssignments).where(eq(schema.enquiryGrowthAssignments.enquiryId, enquiry.id)).orderBy(desc(schema.enquiryGrowthAssignments.assignedAt)),
      ]);
      const research = await Promise.all(runs.map(async (run) => ({ ...run, reviews: await db.select().from(schema.enquiryResearchReviews).where(eq(schema.enquiryResearchReviews.researchId, run.id)) })));
      const workflow = visibleWorkflow({ enquiry, jobs, research, calls });
      byEnquiry[enquiry.id] = { workflow, assignment: assignmentRows[0] ?? null, latestResearchAt: runs[0]?.runAt ?? null };
      counts[workflow.stage] = (counts[workflow.stage] ?? 0) + 1;
    }));
    return { byEnquiry, counts, total: enquiries.length };
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
      if (!result.replayed) await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: req.params.id, type: "call_placed", detail: { callId: result.call.id }, actor: who.staffId });
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
    await db.insert(schema.enquiryGrowthEvents).values({ id: randomUUID(), enquiryId: req.params.id, type: "do_not_contact_set", detail: { reason: parsed.data.reason ?? "operator" }, actor: who.staffId });
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
    await db.insert(schema.enquiryGrowthEvents).values({
      id: randomUUID(), enquiryId: call.enquiryId, type: type === "call_initiation_failure" ? "call_failed" : "call_completed",
      detail: { callId: call.id, conversationId, outcome }, actor: "elevenlabs-webhook",
    });
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
    await db.insert(schema.enquiryGrowthEvents).values({
      id: randomUUID(), enquiryId: parsed.data.enquiryId, type: "do_not_contact_set",
      detail: { reason: parsed.data.reason ?? "requested during call", conversationId: parsed.data.conversationId }, actor: "elevenlabs-agent",
    });
    return { ok: true, doNotContact: true };
  });
}
