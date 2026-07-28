/* ============================================================
   Opening a desk — the signup flow, driveable from either end.

     GET  /api/admin/onboarding/CD-A3V5ZE     → look one up by the
            reference we already gave them, and start or resume it
     GET  /api/admin/onboarding/:ref/flow     → the steps, prefilled
     PATCH/api/admin/onboarding/:ref          → save answers as you type
     POST /api/admin/onboarding/:ref/mark     → paperwork sighted, etc.
     POST /api/admin/onboarding/:ref/create   → build the desk

   The operator presses Onboarding, types the CD reference the applicant
   already has, and works the SAME flow the applicant would — with what
   they told us on the application already filled in. Answers save as
   they go, so it can be put down and picked up by either side.

   Nothing here re-asks a question that has an answer. That is the whole
   design: the flow is one declaration (src/onboarding/flow.ts), the
   answers are resolved from what somebody typed, then the application,
   then what follows from the jurisdiction.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { audit } from "../audit.js";
import {
  PHASES, STEPS, canCreateDesk, fromApplication, resolve, stepById, stepProgress,
  type Answers,
} from "../onboarding/flow.js";
import { resetWalkthrough, WALKTHROUGH_REF } from "../onboarding/walkthrough.js";

const patchBody = z.object({
  stepId: z.string().min(1).max(60),
  answers: z.record(z.string().max(60), z.unknown()),
});
const markBody = z.object({ stepId: z.string().min(1).max(60), done: z.boolean(), note: z.string().max(2000).optional() });

/* The reference an applicant already holds — CD-A3V5ZE, printed on their
   charter card and in every email we have sent them. Typing that is how an
   operator opens the right onboarding without hunting through a list. */
const normalizeRef = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

async function findApplication(db: Db, ref: string) {
  const rows = await db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, normalizeRef(ref))).limit(1);
  const row = rows[0];
  return row && row.kind === "early_access" ? row : undefined;
}

async function loadOrCreate(db: Db, enquiryId: string) {
  const rows = await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(schema.onboarding).values({ enquiryId }).onConflictDoNothing();
  return (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1))[0]!;
}

function present(app: typeof schema.enquiries.$inferSelect, row: typeof schema.onboarding.$inferSelect) {
  const applied = fromApplication(app);
  const entered = (row.answers ?? {}) as Answers;
  const resolved = resolve(entered, applied);
  const marks = (row.marks ?? {}) as Record<string, boolean>;
  const progress = stepProgress(resolved, marks);
  const ready = canCreateDesk(resolved);
  return {
    application: {
      reference: app.reference, charterNo: app.charterNo, email: app.email,
      name: app.name, status: app.status, appliedAt: app.createdAt,
      isWalkthrough: app.isDemo,
      // everything they told us that the flow does NOT ask again — the
      // operator wants to see it while they are on the phone
      told: app.details ?? {},
    },
    phases: PHASES,
    steps: STEPS.map((s) => ({
      ...s,
      fields: s.fields.map((f) => ({ ...f, ...resolved[f.id] })),
      ...progress.find((p) => p.id === s.id)!,
      touchedBy: ((row.touched ?? {}) as Record<string, string>)[s.id] ?? null,
      mark: marks[s.id] ?? false,
    })),
    done: progress.filter((p) => p.done).length,
    total: STEPS.length,
    ready,
    tenantId: row.tenantId,
    updatedAt: row.updatedAt,
  };
}

export function registerOnboardingRoutes(app: FastifyInstance, db: Db, isPlatformAdmin: (email?: string) => boolean): void {
  const gate = async (req: any, reply: any): Promise<SessionUser | null> => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) { reply.code(401).send({ error: "unauthenticated" }); return null; }
    if (!isPlatformAdmin(who.staffId)) { reply.code(403).send({ error: "forbidden", detail: "Platform admin only." }); return null; }
    return who;
  };

  /* Open one by the reference they already hold. Creates the record on first
     look, so "start onboarding" and "carry on with it" are the same action —
     there is no separate thing to remember to begin. */
  app.get<{ Params: { ref: string } }>("/api/admin/onboarding/:ref", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const application = await findApplication(db, req.params.ref);
    if (!application) return reply.code(404).send({ error: "no_such_reference", detail: "No early-access application with that reference." });
    return present(application, await loadOrCreate(db, application.id));
  });

  // save as they type — a flow you cannot put down is a flow people abandon
  app.patch<{ Params: { ref: string } }>("/api/admin/onboarding/:ref", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const application = await findApplication(db, req.params.ref);
    if (!application) return reply.code(404).send({ error: "no_such_reference" });
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const step = stepById(parsed.data.stepId);
    if (!step) return reply.code(404).send({ error: "no_such_step" });
    /* A password we chose is not their password. The operator can fill in
       everything else on their behalf, but not this.

       The walkthrough is the exception, and only because the rule exists to
       protect a real person who is not there: letting it stop at this step
       would mean the one thing you cannot rehearse is the ending. */
    if (step.who === "customer" && !application.isDemo) {
      return reply.code(403).send({ error: "customer_only", detail: `"${step.title}" is the owner's to do — send them their link.` });
    }
    // only fields this step actually declares, so a client cannot write
    // anything it likes into the record
    const allowed = new Set(step.fields.map((f) => f.id));
    const row = await loadOrCreate(db, application.id);
    const answers = { ...((row.answers ?? {}) as Answers) };
    for (const [k, v] of Object.entries(parsed.data.answers)) {
      if (!allowed.has(k)) continue;
      if (v === null || v === "") delete answers[k];
      else answers[k] = v;
    }
    const touched = { ...((row.touched ?? {}) as Record<string, string>), [step.id]: "operator" };
    await db.update(schema.onboarding).set({ answers, touched, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, application.id));
    return present(application, (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, application.id)).limit(1))[0]!);
  });

  // the steps with nothing to type: paperwork sighted, payment cleared
  app.post<{ Params: { ref: string } }>("/api/admin/onboarding/:ref/mark", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const application = await findApplication(db, req.params.ref);
    if (!application) return reply.code(404).send({ error: "no_such_reference" });
    const parsed = markBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const step = stepById(parsed.data.stepId);
    if (!step || step.fields.length) return reply.code(400).send({ error: "not_markable", detail: "That step is answered, not marked." });
    const row = await loadOrCreate(db, application.id);
    const marks = { ...((row.marks ?? {}) as Record<string, unknown>) };
    if (parsed.data.done) marks[step.id] = parsed.data.note ?? true; else delete marks[step.id];
    await db.update(schema.onboarding).set({ marks, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, application.id));
    return present(application, (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, application.id)).limit(1))[0]!);
  });

  /* Build the desk out of the answers. This is the machine doing the work:
     the operator does not retype anything into a second wizard, and what
     opens is exactly what was agreed on the call. */
  app.post<{ Params: { ref: string } }>("/api/admin/onboarding/:ref/create", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const application = await findApplication(db, req.params.ref);
    if (!application) return reply.code(404).send({ error: "no_such_reference" });
    const row = await loadOrCreate(db, application.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", detail: "This desk already exists.", tenantId: row.tenantId });

    const resolved = resolve((row.answers ?? {}) as Answers, fromApplication(application));
    const ready = canCreateDesk(resolved);
    /* The password is the owner's, so we cannot finish this for them — but
       only say that when it is genuinely the last thing. Telling an operator
       "just waiting on them" while three of our own fields are still blank
       sends them to chase a customer who is not the holdup. */
    if (ready.missing.length === 1 && ready.missing[0] === "password") {
      return reply.code(409).send({
        error: "needs_owner",
        detail: "Everything else is ready — the owner sets their own password from their link.",
        missing: ready.missing,
      });
    }
    if (!ready.ok) return reply.code(409).send({ error: "not_ready", detail: "Still needed: " + ready.missing.join(", "), missing: ready.missing });

    /* A rehearsal must not leave a real shop behind. Everything up to here
       ran the same code a real one does — which is the point — and this is
       the one place the walkthrough stops. */
    if (application.isDemo) {
      return reply.code(200).send({
        ok: true, walkthrough: true,
        detail: "That is the whole flow. No desk was created — this is the walkthrough. Reset it to run again.",
      });
    }

    await audit(db, {
      tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id,
      action: "onboarding.ready", detail: { reference: application.reference },
    });
    // handed to the existing signup path, which owns creating a desk
    return {
      ok: true,
      handoff: {
        businessName: resolved.businessName?.value, ownerName: resolved.ownerName?.value,
        email: resolved.email?.value, slug: resolved.slug?.value,
        onboarding: {
          country: resolved.country?.value, regulator: resolved.regulator?.value,
          homeCurrency: resolved.homeCurrency?.value, msbNumber: resolved.msbNumber?.value,
          address: resolved.address?.value, city: resolved.city?.value,
          region: resolved.region?.value, postal: resolved.postal?.value,
          plan: resolved.plan?.value, idThreshold: resolved.idThreshold?.value,
        },
      },
    };
  });

  /* Put the walkthrough back to how it arrives, so it can be run again. Only
     the walkthrough: a reset that could wipe a real applicant's answers is a
     button nobody should have. */
  app.post("/api/admin/onboarding/:ref/reset", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const { ref } = req.params as { ref: string };
    const application = await findApplication(db, ref);
    if (!application) return reply.code(404).send({ error: "no_such_reference" });
    if (!application.isDemo) {
      return reply.code(403).send({ error: "not_the_walkthrough", detail: "Only " + WALKTHROUGH_REF + " can be reset." });
    }
    await resetWalkthrough(db);
    return present(application, await loadOrCreate(db, application.id));
  });
}
