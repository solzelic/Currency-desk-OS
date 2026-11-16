/* ============================================================
   Sign-up v2.1, everything after the email code (SIGNUP-LOGIC §3.3, §4).
   Every route here runs on the ENROLMENT SESSION (§6): issued when the
   code passed, for this one reservation, 24 hours sliding. Without it
   the answer is 401 and the page goes back to "How will you sign in?".

     POST /api/onboarding/:id/pin      { pin, confirm }
     PUT  /api/onboarding/:id/answers  { step, answers }   saves on Continue
     GET  /api/onboarding/:id/resume   → { lastStep, answers, pack, you }
     POST /api/onboarding/:id/confirm  { signed: true, name }   the declaration
     POST /api/onboarding/:id/plan     { plan, term, extras }   → SetupIntent secret
     POST /api/onboarding/:id/open     → a real desk session once Stripe has said yes
   ============================================================ */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { clientIp } from "../auth/client-ip.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";
import { idTail, type IdDoor } from "../onboarding/cd-id-door.js";
import { enrolmentFor } from "../onboarding/email-code.js";
import { loadAccount, withSignupAccount, sha256, type Account } from "../onboarding/signup-account.js";
import { checkPin, savePin } from "../onboarding/signup-pin.js";
import { answersBody, parseAnswers, resumable } from "../onboarding/signup-answers.js";
import { stopSignupCalls, signupCallPreference, saveSignupCallPreference } from "../onboarding/signup-preferences.js";
import { signupPack } from "../onboarding/signup-pack.js";
import { loadOrCreateOnboarding } from "../onboarding/verify.js";
import { ownerDetails } from "./signup-email.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import { acceptServiceAgreement, SERVICE_AGREEMENT_SOURCE_HASH, confirmDesk, declarationName, priceList, startPayment, stillConfirmed, type SignupStripe } from "../onboarding/signup-open.js";
import { stripeBillingConfig, signupStripeClient } from "../billing/stripe.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { ENROLMENT_COOKIE } from "../onboarding/email-code.js";

type Enquiry = typeof schema.enquiries.$inferSelect;
export type Enrolled = { cdId: string; row: Enquiry; account: Account; connection: string };

export function enrolledGuard(db: Db, door: IdDoor) {
  return async function enrolled(req: FastifyRequest<{ Params: { ref: string } }>, reply: FastifyReply): Promise<Enrolled | undefined> {
    const connection = clientIp(req);
    const cdId = normalizeCdIdInput(req.params.ref);
    if (!cdId) { reply.code(404).send({ error: "no_such_id" }); return undefined; }
    if (door.closed(cdId, connection)) { reply.code(429).send({ error: "slow_down" }); return undefined; }
    const row = await door.findByCdId(cdId);
    if (!row) { door.fail(cdId, connection, "enrolled_unknown_id"); reply.code(404).send({ error: "no_such_id" }); return undefined; }
    if (!(await enrolmentFor(db, req, reply, row.id))) {
      door.logRefusal({ reason: "no_enrolment_session", id: idTail(cdId), connection });
      reply.code(401).send({ error: "sign_in_again", detail: "For your security, sign in again to carry on." });
      return undefined;
    }
    const account = await loadAccount(db, row.id);
    if (account.state === "active" || row.status === "accepted") {
      reply.code(409).send({ error: "already_open", detail: "This desk is already open. Sign in." });
      return undefined;
    }
    return { cdId, row, account, connection };
  };
}

const pinBody = z.object({ pin: z.string().max(8), confirm: z.string().max(8) });

const confirmBody = z.object({ signed: z.literal(true), name: z.string().trim().min(2).max(120) });
const planBody = z.object({
  plan: z.enum(["ai", "full", "rates"]),
  term: z.enum(["monthly", "annual"]),
  extras: z.object({ brief: z.boolean(), call: z.boolean(), website: z.boolean(), setupWeek: z.boolean() }).strict(),
  agreed: z.literal(true),
}).strict();

export type DeskDeps = { stripe?: () => SignupStripe | null };

export function registerSignupDeskRoutes(app: FastifyInstance, db: Db, door: IdDoor, deps: DeskDeps = {}): void {
  /* Not configured → null → 503 with a plain line; nothing pretends to take a card. */
  const stripe = deps.stripe ?? (() => {
    const config = stripeBillingConfig();
    return config ? signupStripeClient(config) : null;
  });
  const enrolled = enrolledGuard(db, door);

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/pin", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const parsed = pinBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const verdict = checkPin(parsed.data.pin, parsed.data.confirm);
    if (!verdict.ok) {
      door.logRefusal({ reason: `pin_${verdict.reason}`, id: idTail(r.cdId), connection: r.connection });
      return reply.code(422).send({ error: `pin_${verdict.reason}`, detail: verdict.detail });
    }
    if (!(await savePin(db, r.row.id, parsed.data.pin))) {
      return reply.code(409).send({ error: "not_verified", detail: "Check your inbox first." });
    }
    return { ok: true, strength: verdict.strength };
  });

  /* What the application already told us fills a blank, never an answer
     they have since changed (the older page's rule too). */
  function seeded(row: Enquiry, saved: Record<string, unknown>): Record<string, unknown> {
    const d = row.details ?? {};
    const from: Record<string, unknown> = {
      operatingName: typeof d.shopName === "string" ? d.shopName : undefined,
      msbNumber: typeof d.msbNumber === "string" ? d.msbNumber : undefined,
    };
    const out = { ...saved };
    for (const [k, v] of Object.entries(from)) if (v !== undefined && v !== "" && (out[k] === undefined || out[k] === "")) out[k] = v;
    return out;
  }

  app.put<{ Params: { ref: string } }>("/api/onboarding/:ref/answers", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    if (r.account.state !== "verified") return reply.code(409).send({ error: "not_verified", detail: "Check your inbox first." });
    const body = answersBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: body.error.issues[0]?.message });
    const parsed = parseAnswers(body.data.step, body.data.answers);
    if (!parsed.ok) return reply.code(422).send({ error: "invalid_answer", detail: parsed.detail });
    const saved = await withSignupAccount(db, r.row.id, async (db, account) => {
      if (account.state !== "verified") return false;
      const row = await loadOrCreateOnboarding(db, r.row.id);
      if (row.tenantId) return false;
      const answers = { ...(row.answers ?? {}), ...parsed.values };
      await db.update(schema.onboarding).set({ answers, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, r.row.id));
      await db.update(schema.signupAccounts).set({ lastStep: parsed.step, confirmedAt: null, answersHash: null, setupIntentId: null, planChoice: null, updatedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, r.row.id));
      return true;
    });
    if (!saved) return reply.code(409).send({ error: "already_open" });
    return { ok: true, lastStep: parsed.step };
  });

  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref/resume", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const row = await loadOrCreateOnboarding(db, r.row.id);
    const d = r.row.details ?? {};
    return {
      state: r.account.state,
      lastStep: r.account.lastStep ?? (r.account.pinHash ? "08-shop-name" : "06-pin-intro"),
      /* true: lastStep is the last screen they finished (the page opens the one after it);
         false: nothing saved yet, lastStep is where to start. */
      saved: !!r.account.lastStep,
      pinSet: !!r.account.pinHash,
      answers: resumable(seeded(r.row, row.answers ?? {})),
      pack: signupPack(typeof d.jurisdiction === "string" ? d.jurisdiction : null),
      you: ownerDetails(r.row),
      callPreference: await signupCallPreference(db, r.row.id),
      workspace: typeof d.workspace === "string" ? d.workspace.split(".")[0] : null,
    };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/preferences", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const body = z.discriminatedUnion("call", [
      z.object({ call: z.literal(false) }).strict(),
      z.object({ call: z.literal(true), version: z.string().regex(/^[a-f0-9]{64}$/), target: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ]).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_preference" });
    const result = await saveSignupCallPreference(db, r.row.id, body.data, {
      ipAddress: r.connection, userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
    });
    if (!result.ok) {
      door.logRefusal({ reason: result.error, id: idTail(r.cdId), connection: r.connection });
      return reply.code(409).send({ error: result.error, detail: "Your call details changed. Reload to review them before choosing again." });
    }
    return result;
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/confirm", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const body = confirmBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: "Tick the declaration and sign with your name." });
    if (!r.account.pinHash) return reply.code(409).send({ error: "no_pin", detail: "Set your counter PIN first." });
    if (!(await confirmDesk(db, r.row.id, body.data.name))) return reply.code(409).send({ error: "desk_incomplete", detail: "Complete your shop details and name your compliance officer before signing." });
    const answers = (await loadOrCreateOnboarding(db, r.row.id)).answers ?? {};
    const legal = String(answers.bizName ?? answers.operatingName ?? "");
    return { ok: true, declaration: `I confirm these details are true, and I'm authorised to open this desk for ${declarationName(legal)}.` };
  });

  for (const prepare of [false, true]) app.post<{ Params: { ref: string } }>(`/api/onboarding/:ref/${prepare ? "payment" : "plan"}`, async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const body = (prepare ? planBody.omit({ agreed: true }) : planBody).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: body.error.issues[0]?.message });
    if (r.account.state !== "verified") return reply.code(409).send({ error: "not_verified" });
    if (!body.data.extras.call) await stopSignupCalls(db, r.row.id);
    if (!(await stillConfirmed(db, r.row.id))) return reply.code(409).send({ error: "not_confirmed", detail: "Confirm your desk again; something changed since you signed it." });
    const details = r.row.details ?? {};
    if (signupPack(typeof details.jurisdiction === "string" ? details.jurisdiction : null).billingCurrency !== "CAD") return reply.code(409).send({ error: "billing_country_unavailable" });
    if (body.data.extras.website) return reply.code(409).send({ error: "website_coming_soon" });
    const client = stripe();
    if (!client) return reply.code(503).send({ error: "payment_unavailable", detail: "Card payments aren't switched on here yet. Nothing was charged." });
    const answers = (await loadOrCreateOnboarding(db, r.row.id)).answers ?? {};
    const locations = answers.shops === "more" && typeof answers.shopCount === "number" ? answers.shopCount : 1;
    const choice = { plan: body.data.plan, term: body.data.term, locations, ...body.data.extras };
    try {
      const payment = await startPayment(db, client, r.row, choice, !prepare);
      return { ok: true, ...payment, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null };
    } catch (err) {
      req.log.error({ reason: err instanceof Error ? err.name : "stripe_error", id: idTail(r.cdId) }, "signup SetupIntent failed");
      return reply.code(502).send({ error: "payment_unavailable", detail: "We couldn't reach the card processor. Nothing was charged. Try again in a moment." });
    }
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/agreement", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const body = z.object({ setupIntentId: z.string().startsWith("seti_").max(255), termsSourceHash: z.literal(SERVICE_AGREEMENT_SOURCE_HASH), agreed: z.literal(true) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_agreement" });
    if (!(await acceptServiceAgreement(db, r.row.id, body.data.setupIntentId))) return reply.code(409).send({ error: "agreement_changed", detail: "Your desk or plan changed. Review it and open the card section again." });
    return { ok: true };
  });

  /* The plan screen's prices (build doc §6, payment), for the locations the
     shop's own answers name; the page sends no quantity. The list price for
     one location is public (the plan cards before anyone has an account);
     the quote for this desk needs its enrolment session. Nothing here
     creates a customer or an intent. */
  app.get("/api/onboarding/prices", async () => priceList(1));
  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref/prices", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const details = r.row.details ?? {};
    if (signupPack(typeof details.jurisdiction === "string" ? details.jurisdiction : null).billingCurrency !== "CAD") return reply.code(409).send({ error: "billing_country_unavailable" });
    const answers = (await loadOrCreateOnboarding(db, r.row.id)).answers ?? {};
    return priceList(answers.shops === "more" && typeof answers.shopCount === "number" ? answers.shopCount : 1);
  });

  /* The browser that paid comes in from here. Its enrolment session is the
     proof it is the same person; the account being active is Stripe's yes. */
  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/open", async (req, reply) => {
    const connection = clientIp(req);
    const cdId = normalizeCdIdInput(req.params.ref);
    if (!cdId) return reply.code(404).send({ error: "no_such_id" });
    if (door.closed(cdId, connection)) return reply.code(429).send({ error: "slow_down" });
    const row = await door.findByCdId(cdId);
    if (!row) { door.fail(cdId, connection, "open_unknown_id"); return reply.code(404).send({ error: "no_such_id" }); }
    if (!(await enrolmentFor(db, req, reply, row.id))) return reply.code(401).send({ error: "sign_in_again", detail: "For your security, sign in again to carry on." });
    const token = req.cookies[ENROLMENT_COOKIE];
    if (!token) return reply.code(401).send({ error: "sign_in_again" });
    const result = await withSignupAccount(db, row.id, async (db, account) => {
      const ob = await loadOrCreateOnboarding(db, row.id);
      if (account.state !== "active" || !ob.tenantId) return { kind: "pending", state: account.state } as const;
      const owner = (await db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, ob.tenantId), eq(schema.staffUsers.cdId, cdId))).limit(1))[0];
      if (!owner) return { kind: "no_owner" } as const;
      const spent = await db.update(schema.enrolmentSessions).set({ revokedAt: new Date() }).where(and(
        eq(schema.enrolmentSessions.tokenHash, sha256(token)), eq(schema.enrolmentSessions.enquiryId, row.id),
        isNull(schema.enrolmentSessions.revokedAt), gt(schema.enrolmentSessions.expiresAt, new Date()),
      )).returning();
      if (!spent.length) return { kind: "spent" } as const;
      const session = await createSession(db, owner.id);
      await db.update(schema.enrolmentSessions).set({ revokedAt: new Date() }).where(eq(schema.enrolmentSessions.enquiryId, row.id));
      return { kind: "opened", ob, session } as const;
    });
    if (result.kind === "pending") return reply.code(202).send({ pending: true, state: result.state });
    if (result.kind === "no_owner") return reply.code(409).send({ error: "no_owner" });
    if (result.kind === "spent") return reply.code(401).send({ error: "sign_in_again" });
    const { ob, session } = result;
    reply.setCookie(SESSION_COOKIE, session.token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: session.expiresAt });
    reply.clearCookie(ENROLMENT_COOKIE, { path: "/api/onboarding" });
    const answers = ob.answers ?? {};
    return { ok: true, tenantId: ob.tenantId, cdId, operatingName: String(answers.operatingName ?? row.details?.shopName ?? "") };
  });
}
