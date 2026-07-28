/* ============================================================
   Opening a desk — one process, two doors.

   The owner's door (their own desk, from the OS):
     GET  /api/onboarding                → the steps, and where they are
     POST /api/onboarding/:stepId        → do one
     POST /api/onboarding/:stepId/undo   → put one back
     POST /api/onboarding/launch         → open for business

   The platform team's door (any desk, from the dark panel):
     GET  /api/admin/desks/:tenantId/onboarding
     POST /api/admin/desks/:tenantId/onboarding/:stepId
     POST /api/admin/desks/:tenantId/onboarding/:stepId/undo
     POST /api/admin/desks/:tenantId/onboarding/launch

   Same steps, same record, same rules. That is the point: a desk set up
   in the shop on a Tuesday can be finished by its owner on Wednesday
   night, and neither has to ask the other where they got to.

   Every completed step records WHO did it — the customer, or us on their
   behalf. A desk we set up and one the owner did alone are different
   things, and the difference has to survive.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { audit } from "../audit.js";
import {
  PHASES, STEPS, progressOf, stepById,
  type OnboardingSteps, type StepState,
} from "../onboarding/steps.js";

const completeBody = z.object({
  data: z.record(z.string().max(60), z.unknown()).optional(),
  note: z.string().max(2000).optional(),
});

/* A desk always has one of these, created on demand. Onboarding that only
   exists once somebody has visited a screen is onboarding you cannot report
   on — and "which of my customers is stuck" is the question this answers. */
async function loadOrCreate(db: Db, tenantId: string) {
  const rows = await db.select().from(schema.deskOnboarding).where(eq(schema.deskOnboarding.tenantId, tenantId)).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(schema.deskOnboarding).values({ tenantId, steps: {} }).onConflictDoNothing();
  return (await db.select().from(schema.deskOnboarding).where(eq(schema.deskOnboarding.tenantId, tenantId)).limit(1))[0]!;
}

/* What a desk that came through the public signup has already answered.
   Those questions were asked once; asking them again would make the wizard
   feel like it had not been listening. */
export async function seedFromSignup(db: Db, tenantId: string, actorId: string, setup: Record<string, unknown> | null): Promise<void> {
  const s = setup ?? {};
  const now = new Date().toISOString();
  const done = (data: Record<string, unknown>): StepState => ({ done: true, at: now, by: "customer", actorId, data });
  const steps: OnboardingSteps = {};
  if (s.country || s.regulator) steps.jurisdiction = done({ country: s.country ?? null, regulator: s.regulator ?? null });
  if (s.address || s.city) steps.business = done({ address: s.address ?? null, city: s.city ?? null, region: s.region ?? null, postal: s.postal ?? null });
  if (s.msbNumber) steps.registration = done({ msbNumber: s.msbNumber });
  if (typeof s.idThreshold === "number") steps.thresholds = done({ idThreshold: s.idThreshold });
  // the owner exists by definition — they just signed up
  steps.owner = done({ via: "signup" });
  await db.insert(schema.deskOnboarding).values({ tenantId, steps }).onConflictDoUpdate({
    target: schema.deskOnboarding.tenantId,
    set: { steps, updatedAt: new Date() },
  });
}

const view = (row: typeof schema.deskOnboarding.$inferSelect) => {
  const steps = (row.steps ?? {}) as OnboardingSteps;
  return {
    phases: PHASES,
    steps: STEPS.map((s) => ({ ...s, state: steps[s.id] ?? null })),
    progress: progressOf(steps),
    launchedAt: row.launchedAt, launchedBy: row.launchedBy,
    updatedAt: row.updatedAt,
  };
};

async function complete(
  db: Db, tenantId: string, stepId: string, by: "customer" | "operator",
  actor: SessionUser, body: { data?: Record<string, unknown>; note?: string },
): Promise<{ error?: string; detail?: string; code?: number; row?: typeof schema.deskOnboarding.$inferSelect }> {
  const spec = stepById(stepId);
  if (!spec) return { code: 404, error: "no_such_step" };
  /* Some things stop being true if somebody else does them. A password the
     platform team chose is not the owner's password, however helpful the
     intent — so those steps refuse, rather than quietly recording a lie. */
  if (spec.who === "customer" && by === "operator") {
    return { code: 403, error: "customer_only", detail: `"${spec.title}" has to be done by the owner themselves.` };
  }
  const row = await loadOrCreate(db, tenantId);
  const steps = { ...((row.steps ?? {}) as OnboardingSteps) };
  steps[stepId] = {
    done: true, at: new Date().toISOString(), by, actorId: actor.id,
    ...(body.data ? { data: body.data } : {}),
    ...(body.note ? { note: body.note } : {}),
  };
  await db.update(schema.deskOnboarding).set({ steps, updatedAt: new Date() }).where(eq(schema.deskOnboarding.tenantId, tenantId));
  await audit(db, {
    tenantId, legalEntityId: actor.legalEntityId, branchId: actor.branchId, actorId: actor.id,
    action: "onboarding.step_done", detail: { step: stepId, by },
  });
  return { row: (await db.select().from(schema.deskOnboarding).where(eq(schema.deskOnboarding.tenantId, tenantId)).limit(1))[0]! };
}

async function undo(db: Db, tenantId: string, stepId: string, actor: SessionUser) {
  if (!stepById(stepId)) return { code: 404, error: "no_such_step" };
  const row = await loadOrCreate(db, tenantId);
  const steps = { ...((row.steps ?? {}) as OnboardingSteps) };
  delete steps[stepId];
  await db.update(schema.deskOnboarding).set({ steps, updatedAt: new Date() }).where(eq(schema.deskOnboarding.tenantId, tenantId));
  await audit(db, {
    tenantId, legalEntityId: actor.legalEntityId, branchId: actor.branchId, actorId: actor.id,
    action: "onboarding.step_reopened", detail: { step: stepId },
  });
  return { row: (await db.select().from(schema.deskOnboarding).where(eq(schema.deskOnboarding.tenantId, tenantId)).limit(1))[0]! };
}

async function launch(db: Db, tenantId: string, actor: SessionUser) {
  const row = await loadOrCreate(db, tenantId);
  if (row.launchedAt) return { code: 409, error: "already_launched" };
  const progress = progressOf((row.steps ?? {}) as OnboardingSteps);
  /* The gate is the whole reason the list exists. A desk that opens with
     paperwork outstanding is one we cannot answer for. */
  if (!progress.canLaunch) {
    return { code: 409, error: "not_ready", detail: "Still outstanding: " + progress.blocking.join(", "), blocking: progress.blocking };
  }
  const at = new Date();
  await db.update(schema.deskOnboarding).set({ launchedAt: at, launchedBy: actor.id, updatedAt: at }).where(eq(schema.deskOnboarding.tenantId, tenantId));
  await audit(db, {
    tenantId, legalEntityId: actor.legalEntityId, branchId: actor.branchId, actorId: actor.id,
    action: "onboarding.launched",
  });
  return { row: (await db.select().from(schema.deskOnboarding).where(eq(schema.deskOnboarding.tenantId, tenantId)).limit(1))[0]! };
}

export function registerOnboardingRoutes(app: FastifyInstance, db: Db, isPlatformAdmin: (email?: string) => boolean): void {
  const me = async (req: { cookies: Record<string, string | undefined> }) => resolveSession(db, req.cookies[SESSION_COOKIE]);

  // ---- the owner's own desk -------------------------------------------
  app.get("/api/onboarding", async (req, reply) => {
    const who = await me(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    return view(await loadOrCreate(db, who.tenantId));
  });

  app.post<{ Params: { stepId: string } }>("/api/onboarding/:stepId", async (req, reply) => {
    const who = await me(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = completeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const r = await complete(db, who.tenantId, req.params.stepId, "customer", who, parsed.data);
    if (r.code) return reply.code(r.code).send({ error: r.error, detail: r.detail });
    return view(r.row!);
  });

  app.post<{ Params: { stepId: string } }>("/api/onboarding/:stepId/undo", async (req, reply) => {
    const who = await me(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const r = await undo(db, who.tenantId, req.params.stepId, who);
    if (r.code) return reply.code(r.code).send({ error: r.error });
    return view(r.row!);
  });

  app.post("/api/onboarding/launch", async (req, reply) => {
    const who = await me(req);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const r = await launch(db, who.tenantId, who);
    if (r.code) return reply.code(r.code).send({ error: r.error, detail: r.detail, blocking: r.blocking });
    return view(r.row!);
  });

  // ---- the platform team, on any desk ---------------------------------
  const gate = async (req: any, reply: any): Promise<SessionUser | null> => {
    const who = await me(req);
    if (!who) { reply.code(401).send({ error: "unauthenticated" }); return null; }
    if (!isPlatformAdmin(who.staffId)) { reply.code(403).send({ error: "forbidden", detail: "Platform admin only." }); return null; }
    return who;
  };
  const deskExists = async (tenantId: string) =>
    !!(await db.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1))[0];

  app.get<{ Params: { tenantId: string } }>("/api/admin/desks/:tenantId/onboarding", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    if (!(await deskExists(req.params.tenantId))) return reply.code(404).send({ error: "not_found" });
    return view(await loadOrCreate(db, req.params.tenantId));
  });

  app.post<{ Params: { tenantId: string; stepId: string } }>("/api/admin/desks/:tenantId/onboarding/:stepId", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    if (!(await deskExists(req.params.tenantId))) return reply.code(404).send({ error: "not_found" });
    const parsed = completeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const r = await complete(db, req.params.tenantId, req.params.stepId, "operator", who, parsed.data);
    if (r.code) return reply.code(r.code).send({ error: r.error, detail: r.detail });
    return view(r.row!);
  });

  app.post<{ Params: { tenantId: string; stepId: string } }>("/api/admin/desks/:tenantId/onboarding/:stepId/undo", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    if (!(await deskExists(req.params.tenantId))) return reply.code(404).send({ error: "not_found" });
    const r = await undo(db, req.params.tenantId, req.params.stepId, who);
    if (r.code) return reply.code(r.code).send({ error: r.error });
    return view(r.row!);
  });

  app.post<{ Params: { tenantId: string } }>("/api/admin/desks/:tenantId/onboarding/launch", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    if (!(await deskExists(req.params.tenantId))) return reply.code(404).send({ error: "not_found" });
    const r = await launch(db, req.params.tenantId, who);
    if (r.code) return reply.code(r.code).send({ error: r.error, detail: r.detail, blocking: r.blocking });
    return view(r.row!);
  });
}
