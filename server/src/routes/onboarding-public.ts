/* ============================================================
   The applicant's own door into onboarding.

     GET   /api/onboarding/:ref     → their flow, with what they told us
     PATCH /api/onboarding/:ref     → save answers as they go
     POST  /api/onboarding/:ref/submit → hand it to signup

   They get an email with their code and a link. They type the code and
   walk through it. Same record the platform team works from the panel,
   so whatever we filled in at their counter is already there, and
   whatever they do here is waiting for us.

   The code IS the key — that is the design, and it is the same trust
   model as any emailed link: holding it proves the email reached them.
   Six characters from a 32-letter alphabet is about a billion, and a
   wrong guess is rate-limited hard, so it cannot be walked. Only an
   application we have actually invited will open.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import {
  PHASES, STEPS, canCreateDesk, fromApplication, resolve, stepById, stepProgress,
  type Answers,
} from "../onboarding/flow.js";

const patchBody = z.object({
  stepId: z.string().min(1).max(60),
  answers: z.record(z.string().max(60), z.unknown()),
});

const stateBody = z.object({
  at: z.number().int().min(0).max(64),
  data: z.record(z.string().max(60), z.unknown()),
});

const normalizeRef = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

/* Guessing a code has to be pointless. Failures are what we count — somebody
   working through their own onboarding saves constantly and must never be
   throttled for it. */
const misses = new Map<string, number[]>();
const MISS_WINDOW_MS = 60 * 60 * 1000;
const MISS_MAX = 12;
function tooManyMisses(ip: string): boolean {
  const now = Date.now();
  const hits = (misses.get(ip) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
  misses.set(ip, hits);
  return hits.length >= MISS_MAX;
}
function recordMiss(ip: string): void {
  const now = Date.now();
  const hits = (misses.get(ip) ?? []).filter((t) => now - t < MISS_WINDOW_MS);
  hits.push(now);
  misses.set(ip, hits);
  for (const [k, v] of misses) if (!v.some((t) => now - t < MISS_WINDOW_MS)) misses.delete(k);
}

export function registerPublicOnboardingRoutes(app: FastifyInstance, db: Db): void {
  /* Only an invited application opens. An application still being read, or
     one we turned down, is not a door — and the answer is the same either
     way so the code cannot be used to find out which. */
  async function find(ref: string) {
    const rows = await db.select().from(schema.enquiries).where(eq(schema.enquiries.reference, normalizeRef(ref))).limit(1);
    const row = rows[0];
    if (!row || row.kind !== "early_access") return undefined;
    if (row.status !== "invited" && row.status !== "accepted") return undefined;
    return row;
  }

  async function loadOrCreate(enquiryId: string) {
    const rows = await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1);
    if (rows[0]) return rows[0];
    await db.insert(schema.onboarding).values({ enquiryId }).onConflictDoNothing();
    return (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, enquiryId)).limit(1))[0]!;
  }

  /* What the applicant is allowed to see. Deliberately less than the panel
     shows: their own answers and their own progress, never our notes, never
     their charter position relative to anybody else. */
  function present(a: typeof schema.enquiries.$inferSelect, row: typeof schema.onboarding.$inferSelect) {
    const applied = fromApplication(a);
    const resolved = resolve((row.answers ?? {}) as Answers, applied);
    const marks = (row.marks ?? {}) as Record<string, boolean>;
    const progress = stepProgress(resolved, marks);
    return {
      you: { name: a.name, email: a.email, reference: a.reference, charterNo: a.charterNo },
      phases: PHASES,
      steps: STEPS.map((s) => {
        const p = progress.find((x) => x.id === s.id)!;
        return {
          id: s.id, phase: s.phase, title: s.title, blurb: s.blurb, kind: s.kind, who: s.who,
          fields: s.fields.map((f) => ({ ...f, value: resolved[f.id]?.value ?? null, source: resolved[f.id]?.source ?? null })),
          done: p.done, missing: p.missing,
          // so the screen can say "we already have this from your application"
          touchedBy: ((row.touched ?? {}) as Record<string, string>)[s.id] ?? null,
        };
      }),
      done: progress.filter((p) => p.done).length,
      total: STEPS.length,
      ready: canCreateDesk(resolved),
      createdDesk: row.tenantId,
    };
  }

  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down", detail: "Too many tries. Wait a while, then check the code in your email." });
    const a = await find(req.params.ref);
    if (!a) {
      recordMiss(req.ip);
      return reply.code(404).send({ error: "no_such_code", detail: "We don't recognise that code. Check the email we sent you." });
    }
    return present(a, await loadOrCreate(a.id));
  });

  app.patch<{ Params: { ref: string } }>("/api/onboarding/:ref", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const step = stepById(parsed.data.stepId);
    if (!step) return reply.code(404).send({ error: "no_such_step" });

    const allowed = new Set(step.fields.map((f) => f.id));
    const row = await loadOrCreate(a.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", detail: "Your desk is already open — sign in instead." });
    const answers = { ...((row.answers ?? {}) as Answers) };
    for (const [k, v] of Object.entries(parsed.data.answers)) {
      if (!allowed.has(k)) continue;
      if (v === null || v === "") delete answers[k];
      else answers[k] = v;
    }
    // "customer" is the honest value here — this is them, at their own screen
    const touched = { ...((row.touched ?? {}) as Record<string, string>), [step.id]: "customer" };
    await db.update(schema.onboarding).set({ answers, touched, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, a.id));
    return present(a, (await db.select().from(schema.onboarding).where(eq(schema.onboarding.enquiryId, a.id)).limit(1))[0]!);
  });

  /* Everything is answered — hand it to the signup path, which owns creating
     a desk and emailing the code that confirms the address. */
  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/submit", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const row = await loadOrCreate(a.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", tenantId: row.tenantId });

    const resolved = resolve((row.answers ?? {}) as Answers, fromApplication(a));
    const ready = canCreateDesk(resolved);
    if (!ready.ok) return reply.code(409).send({ error: "not_ready", missing: ready.missing });
    if (a.isDemo) {
      return { ok: true, walkthrough: true, detail: "That is the whole flow — this is the walkthrough, so no desk was created." };
    }
    // the shape /api/signup takes; the browser posts it and handles the code
    return {
      ok: true,
      signup: {
        businessName: resolved.businessName?.value, ownerName: resolved.ownerName?.value,
        email: resolved.email?.value, password: resolved.password?.value, slug: resolved.slug?.value,
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

  /* The designed flow keeps its own shape — the 24 screens in
     CurrencyDesk Onboarding.html, with their own field names. We store that
     blob as it is rather than translating it: the design owns what it asks,
     and a mapping layer in the middle is a thing that silently goes stale
     every time a screen changes.

       GET → what they have so far, seeded from their application
       PUT → the whole state, debounced by the page

     `at` is the screen they are on, so it reopens where they stopped. */
  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref/state", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const row = await loadOrCreate(a.id);
    const saved = (row.answers ?? {}) as Record<string, unknown>;
    const d = (saved.__flow ?? {}) as Record<string, unknown>;
    const details = (a.details ?? {}) as Record<string, unknown>;
    /* Nothing they have already told us gets asked again. Only fills a blank —
       an answer they have since changed is theirs, not ours to overwrite. */
    const seeded: Record<string, unknown> = { ...d };
    const seed = (k: string, v: unknown) => { if (v && !seeded[k]) seeded[k] = v; };
    seed("ownerName", a.name);
    seed("ownerEmail", a.email);
    seed("country", details.jurisdiction);
    seed("website", details.website === "none yet" ? "" : details.website);
    if (typeof details.workspace === "string") seed("operatingName", "");
    return {
      at: typeof saved.__at === "number" ? saved.__at : 0,
      data: seeded,
      application: { reference: a.reference, name: a.name, email: a.email, told: details },
    };
  });

  app.put<{ Params: { ref: string } }>("/api/onboarding/:ref/state", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = stateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const row = await loadOrCreate(a.id);
    const answers = { ...((row.answers ?? {}) as Record<string, unknown>) };
    /* The card is the one thing we will not hold. It goes to Stripe from the
       browser and never through here — a saved PAN is a liability nobody
       asked us to take on. */
    const d = { ...parsed.data.data };
    for (const k of ["cardNum", "cardCvc", "cardExp", "card2Num", "card2Cvc", "card2Exp", "ownerPass"]) delete d[k];
    answers.__flow = d;
    answers.__at = parsed.data.at;
    const touched = { ...((row.touched ?? {}) as Record<string, string>), flow: "customer" };
    await db.update(schema.onboarding).set({ answers, touched, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, a.id));
    return { ok: true };
  });
}
