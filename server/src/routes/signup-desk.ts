/* ============================================================
   Sign-up v2.1, everything after the email code (SIGNUP-LOGIC §3.3, §4).
   Every route here runs on the ENROLMENT SESSION (§6): issued when the
   code passed, for this one reservation, 24 hours sliding. Without it
   the answer is 401 and the page goes back to "How will you sign in?".

     POST /api/onboarding/:id/pin      { pin, confirm }
     PUT  /api/onboarding/:id/answers  { step, answers }   saves on Continue
     GET  /api/onboarding/:id/resume   → { lastStep, answers, pack, you }
   ============================================================ */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { clientIp } from "../auth/client-ip.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";
import { idTail, type IdDoor } from "../onboarding/cd-id-door.js";
import { enrolmentFor } from "../onboarding/email-code.js";
import { loadAccount, type Account } from "../onboarding/signup-account.js";
import { checkPin, savePin } from "../onboarding/signup-pin.js";
import { answersBody, parseAnswers, resumable } from "../onboarding/signup-answers.js";
import { signupPack } from "../onboarding/signup-pack.js";
import { loadOrCreateOnboarding } from "../onboarding/verify.js";
import { ownerDetails } from "./signup-email.js";
import { eq } from "drizzle-orm";

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

export function registerSignupDeskRoutes(app: FastifyInstance, db: Db, door: IdDoor): void {
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
    const d = (row.details ?? {}) as Record<string, unknown>;
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
    const row = await loadOrCreateOnboarding(db, r.row.id);
    if (row.tenantId) return reply.code(409).send({ error: "already_open", detail: "This desk is already open. Sign in." });
    const answers = { ...((row.answers ?? {}) as Record<string, unknown>), ...parsed.values };
    await db.update(schema.onboarding).set({ answers, updatedAt: new Date() }).where(eq(schema.onboarding.enquiryId, r.row.id));
    await db.update(schema.signupAccounts).set({ lastStep: parsed.step, updatedAt: new Date() }).where(eq(schema.signupAccounts.enquiryId, r.row.id));
    return { ok: true, lastStep: parsed.step };
  });

  app.get<{ Params: { ref: string } }>("/api/onboarding/:ref/resume", async (req, reply) => {
    const r = await enrolled(req, reply);
    if (!r) return;
    const row = await loadOrCreateOnboarding(db, r.row.id);
    const d = (r.row.details ?? {}) as Record<string, unknown>;
    return {
      state: r.account.state,
      lastStep: r.account.lastStep ?? (r.account.pinHash ? "08-shop-name" : "06-pin-intro"),
      pinSet: !!r.account.pinHash,
      answers: resumable(seeded(r.row, (row.answers ?? {}) as Record<string, unknown>)),
      pack: signupPack(typeof d.jurisdiction === "string" ? d.jurisdiction : null),
      you: ownerDetails(r.row),
      workspace: typeof d.workspace === "string" ? d.workspace.split(".")[0] : null,
    };
  });
}
