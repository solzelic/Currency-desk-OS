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
import { hashPassword } from "../auth/password.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { codeMatches, hashCode, makeCode, sendEmail, verificationEmail } from "../email.js";
import { normalizePhone, sendSms } from "../sms.js";
import { forgetClaimedCount } from "./early-access.js";
import {
  JURISDICTION, PHASES, STEPS, canCreateDesk, fromApplication, resolve, stepById, stepProgress,
  type Answers,
} from "../onboarding/flow.js";
import { closeApplication, freeSlug, provisionDesk, specFromAnswers } from "../onboarding/provision.js";

const patchBody = z.object({
  stepId: z.string().min(1).max(60),
  answers: z.record(z.string().max(60), z.unknown()),
});

const stateBody = z.object({
  at: z.number().int().min(0).max(64),
  data: z.record(z.string().max(60), z.unknown()),
});

const launchBody = z.object({ data: z.record(z.string().max(60), z.unknown()).optional() });
const codeBody = z.object({ code: z.string().trim().min(4).max(10) });

const normalizeRef = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");

/* ------------------------------------------------------------------
   Which channel confirms the account.

   The design confirms a mobile by text, and the copy on that screen
   says so. There is no SMS provider yet, so today the code goes to the
   owner's email — which is not a downgrade: it is the address the
   invite already reached and the thing they sign in with.

   This constant is the whole switch. The server sends over it, the page
   words itself from it, and turning VERIFY_CHANNEL=phone on a box with
   Twilio credentials moves the whole flow back to SMS without a screen
   changing or a rebuild.
   ------------------------------------------------------------------ */
export const VERIFY_CHANNEL: "email" | "phone" =
  process.env.VERIFY_CHANNEL === "phone" ? "phone" : "email";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

/* Where the confirmation state lives on the onboarding row. Under a
   double-underscore key because `answers` is otherwise exactly the design's
   field list, and anything in here is ours rather than theirs. */
interface VerifyState {
  codeHash?: string;
  attempts?: number;
  expiresAt?: number;
  confirmedAt?: number;
  channel?: string;
  sentTo?: string;
}

/* The design's answers, whichever shape the row is in. Rows written before
   the two surfaces were brought onto one field list keep theirs under
   `__flow`; they are read here and written back flat on the next save. */
function flowAnswers(row: { answers?: Record<string, unknown> | null }): Record<string, unknown> {
  const a = (row.answers ?? {}) as Record<string, unknown>;
  const legacy = (a.__flow ?? null) as Record<string, unknown> | null;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (!k.startsWith("__")) flat[k] = v;
  return legacy ? { ...legacy, ...flat } : flat;
}

/* Two things never get stored.

   The card, because a saved PAN is a liability nobody asked us to take on —
   it goes to the payment provider from the browser and never through here.

   The password, because it is the owner's; it arrives only on the request
   that creates the desk, is hashed, and is never written to `answers`.

   And nothing may write our own `__` keys, or a browser could mark itself
   confirmed. */
function stripSecrets(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const secret = new Set(["cardNum", "cardCvc", "cardExp", "card2Num", "card2Cvc", "card2Exp", "ownerPass", "backup"]);
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("__") || secret.has(k)) continue;
    out[k] = v;
  }
  return out;
}

const sentToFor = (data: Record<string, unknown>, a: { email: string }): string =>
  VERIFY_CHANNEL === "phone"
    ? String(data.phone ?? "")
    : String(data.ownerEmail ?? a.email ?? "");

/* Asking for another code has to be cheap for somebody whose email is slow
   and expensive for anybody else. */
const sends = new Map<string, number[]>();
function allow(key: string, max: number, windowMs = 60 * 60 * 1000): boolean {
  const now = Date.now();
  const hits = (sends.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  sends.set(key, hits);
  return true;
}

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

  const verifyStateOf = (row: { answers?: Record<string, unknown> | null }): VerifyState =>
    (((row.answers ?? {}) as Record<string, unknown>).__verify ?? {}) as VerifyState;

  async function setVerifyState(enquiryId: string, patch: VerifyState): Promise<void> {
    const row = await loadOrCreate(enquiryId);
    const answers = { ...((row.answers ?? {}) as Record<string, unknown>) };
    answers.__verify = { ...verifyStateOf(row), ...patch };
    await db.update(schema.onboarding).set({ answers, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, enquiryId));
  }

  /* A code is one code. Issuing a new one resets the attempt count and
     invalidates the last, so "send it again" is always the right advice. */
  const issueCode = (enquiryId: string, code: string, sentTo: string) =>
    setVerifyState(enquiryId, {
      codeHash: hashCode(code),
      attempts: 0,
      expiresAt: Date.now() + CODE_TTL_MS,
      confirmedAt: undefined,
      channel: VERIFY_CHANNEL,
      sentTo,
    });

  async function checkCode(
    a: { id: string },
    entered: string,
  ): Promise<{ ok: true } | { ok: false; status: number; error: string; detail: string }> {
    const row = await loadOrCreate(a.id);
    const v = verifyStateOf(row);
    if (!v.codeHash) return { ok: false, status: 409, error: "no_code", detail: "We haven't sent a code yet — ask for one." };
    if ((v.expiresAt ?? 0) < Date.now()) return { ok: false, status: 410, error: "expired", detail: "That code expired — ask for a new one." };
    if ((v.attempts ?? 0) >= MAX_CODE_ATTEMPTS) return { ok: false, status: 429, error: "too_many_attempts", detail: "Too many tries — ask for a new code." };
    if (!codeMatches(entered, v.codeHash)) {
      await setVerifyState(a.id, { attempts: (v.attempts ?? 0) + 1 });
      return { ok: false, status: 401, error: "wrong_code", detail: "That code isn't right — check and try again." };
    }
    await setVerifyState(a.id, { confirmedAt: Date.now() });
    return { ok: true };
  }

  async function isConfirmed(a: { id: string }): Promise<boolean> {
    const row = await loadOrCreate(a.id);
    return !!verifyStateOf(row).confirmedAt;
  }

  async function emailHasDesk(email: string): Promise<boolean> {
    const rows = await db.select({ id: schema.staffUsers.id }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, email)).limit(1);
    return rows.length > 0;
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

  /* The designed flow's own state.

       GET → what they have so far, seeded from their application
       PUT → the whole state, debounced by the page

     `at` is the screen they are on, so it reopens where they stopped.

     The answers are stored FLAT, under the design's own field names, which
     is the same place and the same names the panel reads and writes. There
     used to be a `__flow` blob beside the panel's answers, and the two
     surfaces slowly stopped agreeing about what a desk had. Rows written
     before that are still read below, once, and then written back flat. */
  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref/state", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const row = await loadOrCreate(a.id);
    const saved = flowAnswers(row);
    const details = (a.details ?? {}) as Record<string, unknown>;
    /* Nothing they have already told us gets asked again. Only fills a blank —
       an answer they have since changed is theirs, not ours to overwrite. */
    const seeded: Record<string, unknown> = { ...saved };
    for (const [k, v] of Object.entries(fromApplication(a))) {
      if (v !== undefined && v !== "" && !seeded[k]) seeded[k] = v;
    }
    /* Picking a country on screen 1 is what sets the ID threshold to the
       regulator's number. Seeding the country from their application skips
       that, so the screen that asks "when should the desk ask for ID?" would
       open with nothing chosen and no default behind it. Seed the same
       answer the design would have set. */
    const j = JURISDICTION[String(seeded.country ?? "")];
    if (j && !seeded.idOver) seeded.idOver = String(j.reportThreshold);
    return {
      at: typeof (row.answers as Record<string, unknown>)?.__at === "number" ? (row.answers as Record<string, number>).__at : 0,
      data: seeded,
      application: { reference: a.reference, name: a.name, email: a.email, told: details },
      /* Which channel confirms the account, decided here because this is the
         thing that actually sends. The page renders whatever it is told. */
      verify: { channel: VERIFY_CHANNEL, sentTo: sentToFor(seeded, a) },
      createdDesk: row.tenantId,
    };
  });

  app.put<{ Params: { ref: string } }>("/api/onboarding/:ref/state", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = stateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const row = await loadOrCreate(a.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", detail: "Your desk is already open — sign in instead." });

    const incoming = stripSecrets(parsed.data.data);
    const answers = { ...((row.answers ?? {}) as Record<string, unknown>), ...incoming };
    delete answers.__flow; // the old shape, retired on first write
    answers.__at = parsed.data.at;

    /* Where each answer came from. An operator looking at this record needs to
       know which of it arrived through the customer's own screens — that is
       the difference between "they told us this" and "confirm it with them".
       Recorded per field, because a step is too coarse: half of one screen can
       be ours from their application and half theirs.

       Two things are deliberately NOT marked as theirs. A blank is not an
       answer. And a value we seeded from their application is ours — the page
       hands the whole blob back on every save, so without this every seeded
       field would claim to have been typed on the spot. */
    const prior = flowAnswers(row);
    const seeded = fromApplication(a) as Record<string, unknown>;
    const touched: Record<string, unknown> = { ...((row.touched ?? {}) as Record<string, unknown>), flow: "customer" };
    const by = { ...((touched.__by ?? {}) as Record<string, string>) };
    for (const [k, v] of Object.entries(incoming)) {
      const isBlank =
        v === null || v === undefined || v === "" ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
      if (isBlank) { delete by[k]; continue; }
      if (JSON.stringify(seeded[k]) === JSON.stringify(v)) { delete by[k]; continue; }
      if (JSON.stringify(prior[k]) !== JSON.stringify(v)) by[k] = "customer";
    }
    touched.__by = by;
    await db.update(schema.onboarding).set({ answers, touched, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, a.id));
    return { ok: true };
  });

  /* ----------------------------------------------------------------
     Confirming the account.

     The design confirms a mobile by text. There is no SMS provider yet,
     so the code goes to the owner's email — the address the invite
     already reached, which makes it a confirmation of the thing that
     actually signs them in. The channel is one constant, read by both
     this file and the page, so the day a provider exists this becomes
     phone and no screen changes.

     Sending stages a pending signup at the same time: the desk is
     described before it is created, which is what lets the code be
     checked here and the desk be built on the next screen without the
     browser holding anything sensitive in between.
     ---------------------------------------------------------------- */
  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/verify/send", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = launchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const row = await loadOrCreate(a.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", detail: "Your desk is already open — sign in instead." });

    // whatever the page has now wins over whatever it last saved
    const merged = { ...flowAnswers(row), ...stripSecrets(parsed.data.data ?? {}) };
    const resolved = resolve(merged, fromApplication(a));
    const email = String(resolved.ownerEmail?.value ?? "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(email)) {
      return reply.code(400).send({ error: "no_email", detail: "We need the owner's email address before we can send a code." });
    }
    if (!allow("onb-send:" + a.reference, 8)) {
      return reply.code(429).send({ error: "slow_down", detail: "Hold on — wait a moment before asking for another code." });
    }

    const code = makeCode();
    const to = VERIFY_CHANNEL === "phone" ? String(resolved.phone?.value ?? "") : email;
    await issueCode(a.id, code, to);

    /* The rehearsal still issues a real code and still has to be typed —
       a walkthrough that skips the interesting part rehearses the boring
       one. It just goes to the log instead of to somebody's inbox. */
    if (a.isDemo) {
      console.log(`[walkthrough] confirmation code for ${a.reference} is ${code}`);
    } else if (VERIFY_CHANNEL === "phone") {
      const num = normalizePhone(to);
      if (!num) return reply.code(400).send({ error: "bad_phone", detail: "That mobile number doesn't look right." });
      await sendSms(num, `${code} is your CurrencyDesk confirmation code.`);
    } else {
      const mail = verificationEmail(code, String(resolved.operatingName?.value ?? "your desk"));
      await sendEmail(email, mail.subject, { text: mail.text, html: mail.html });
    }
    return { ok: true, channel: VERIFY_CHANNEL, sentTo: to };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/verify/check", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = codeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const check = await checkCode(a, parsed.data.code);
    if (!check.ok) return reply.code(check.status).send({ error: check.error, detail: check.detail });
    return { ok: true };
  });

  /* ----------------------------------------------------------------
     The end of it: create the desk.

     Everything before this screen is answers. This is where a shop
     exists — tenant, legal entity, branch, till, the owner's login and
     everyone they listed — and where the application stops being an
     application.
     ---------------------------------------------------------------- */
  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/launch", async (req, reply) => {
    if (tooManyMisses(req.ip)) return reply.code(429).send({ error: "slow_down" });
    const a = await find(req.params.ref);
    if (!a) { recordMiss(req.ip); return reply.code(404).send({ error: "no_such_code" }); }
    const parsed = launchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const row = await loadOrCreate(a.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_created", detail: "Your desk is already open — sign in instead.", tenantId: row.tenantId });

    const supplied = parsed.data.data ?? {};
    const merged = { ...flowAnswers(row), ...stripSecrets(supplied) };
    const resolved = resolve(merged, fromApplication(a));

    /* The password never touches the stored answers, so it has to come off
       the request that is creating the desk. */
    const password = typeof supplied.ownerPass === "string" ? supplied.ownerPass : "";
    if (password.length < 6) {
      return reply.code(400).send({ error: "no_password", detail: "Set a password of at least 6 characters before opening the desk." });
    }

    const ready = canCreateDesk({ ...resolved, ownerPass: { value: password, source: "entered" } });
    if (!ready.ok) {
      return reply.code(409).send({ error: "not_ready", missing: ready.missing, detail: "Still needed: " + ready.missing.join(", ") });
    }

    /* Confirming the account is not decoration. A desk whose owner never
       proved they hold the address cannot be signed into by anybody we can
       reach, and it is the only thing standing between the invite link and
       an account in somebody else's name. */
    const confirmed = await isConfirmed(a);
    if (!confirmed) {
      return reply.code(403).send({ error: "not_confirmed", detail: "Confirm the code we sent you before opening the desk." });
    }

    if (a.isDemo) {
      /* A rehearsal must not leave a real shop behind. Everything up to here
         ran the code a real one does — which is the point — and this is the
         one place the walkthrough stops. */
      await db.update(schema.onboarding).set({ updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, a.id));
      return { ok: true, walkthrough: true, detail: "That is the whole flow — this is the walkthrough, so no desk was created." };
    }

    const spec = specFromAnswers(resolved, a);
    if (!spec.email || !spec.businessName) {
      return reply.code(409).send({ error: "not_ready", detail: "We still need the shop name and the owner's email." });
    }
    if (await emailHasDesk(spec.email)) {
      return reply.code(409).send({ error: "email_in_use", detail: "That email already has a desk — sign in instead." });
    }
    spec.slug = await freeSlug(db, spec.slug, spec.email);

    forgetClaimedCount();
    const made = await provisionDesk(db, spec, await hashPassword(password), "onboarding");
    await db.delete(schema.pendingSignups).where(eq(schema.pendingSignups.email, spec.email));
    await db
      .update(schema.onboarding)
      .set({ tenantId: made.tenantId, updatedAt: new Date() })
      .where(eq(schema.onboarding.enquiryId, a.id));
    await closeApplication(db, spec.email, made.tenantId, "onboarding");

    /* Signed in on the spot. Making somebody who has just finished fifteen
       screens go and find a login page is a strange last impression. */
    const { token, expiresAt } = await createSession(db, made.ownerId);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/", expires: expiresAt,
    });
    return reply.code(201).send({
      ok: true,
      tenantId: made.tenantId,
      slug: made.slug,
      signedIn: true,
      staffCreated: made.staffCreated,
      goTo: "/app",
    });
  });
}
