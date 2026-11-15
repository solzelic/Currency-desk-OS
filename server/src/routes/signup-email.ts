/* ============================================================
   Sign-up v2.1: "Check your inbox" (SIGNUP-LOGIC §3.2).

     POST /api/onboarding/:id/email/send     "No email yet? Send it again"
     POST /api/onboarding/:id/email/verify   { code } → enrolment session

   Both need the browser that saved a candidate credential (its attempt
   cookie). Refusals: 401 wrong, 410 expired, 423 five wrong (the code is
   burnt; send a new one), 429 too soon; each logged with a reason code.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { clientIp } from "../auth/client-ip.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";
import { idTail, operatingNameOf, type IdDoor } from "../onboarding/cd-id-door.js";
import { existingAttempt, loadAccount } from "../onboarding/signup-account.js";
import { maskEmail, maskPhone, sendSignupCode, setEnrolmentCookie, verifySignupCode, type Mailer } from "../onboarding/email-code.js";
import { sendEmail } from "../email.js";

const codeBody = z.object({ code: z.string().trim().min(1).max(12) });

const DETAIL: Record<string, string> = {
  wrong_code: "That code isn't right. Check the email and try again.",
  expired: "That code has expired. Send it again for a new one.",
  too_many_attempts: "Too many tries on that code. Send it again for a new one.",
  no_code: "We haven't sent a code yet. Send it again.",
  no_candidate: "Choose how you'll sign in first, on this device.",
  not_enrolling: "There's nothing waiting for a code here.",
};

type Enquiry = typeof schema.enquiries.$inferSelect;

/** What the owner may see once the code has passed (§3: details appear). */
export function ownerDetails(row: Enquiry) {
  const d = (row.details ?? {}) as Record<string, unknown>;
  const name = [d.firstName, d.lastName].filter((x) => typeof x === "string" && x).join(" ") || String(row.name ?? "");
  return {
    name,
    email: maskEmail(row.email),
    mobile: typeof d.phone === "string" ? maskPhone(d.phone) : "",
    country: typeof d.country === "string" ? d.country : "",
  };
}

export function registerSignupEmailRoutes(app: FastifyInstance, db: Db, door: IdDoor, deps: { mail?: Mailer } = {}): void {
  const mail = deps.mail ?? sendEmail;

  type Found =
    | { found: false; status: 404 | 429; body: { error: string } }
    | { found: true; cdId: string; row: Enquiry; account: Awaited<ReturnType<typeof loadAccount>> };
  async function enrolling(ref: string, ip: string): Promise<Found> {
    const cdId = normalizeCdIdInput(ref);
    if (!cdId) return { found: false, status: 404, body: { error: "no_such_id" } };
    if (door.closed(cdId, ip)) return { found: false, status: 429, body: { error: "slow_down" } };
    const row = await door.findByCdId(cdId);
    if (!row) { door.fail(cdId, ip, "code_unknown_id"); return { found: false, status: 404, body: { error: "no_such_id" } }; }
    return { found: true, cdId, row, account: await loadAccount(db, row.id) };
  }

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/email/send", async (req, reply) => {
    const ip = clientIp(req);
    const r = await enrolling(req.params.ref, ip);
    if (!r.found) return reply.code(r.status).send(r.body);
    const attempt = existingAttempt(req);
    const candidate = attempt && (await db.select().from(schema.signupCredentials).where(and(
      eq(schema.signupCredentials.enquiryId, r.row.id), eq(schema.signupCredentials.attemptHash, attempt), isNull(schema.signupCredentials.verifiedAt),
    )).limit(1))[0];
    if (r.account.state !== "enrolling" || !candidate) return reply.code(409).send({ error: "no_candidate", detail: DETAIL.no_candidate });
    const sent = await sendSignupCode(db, r.row, operatingNameOf(r.row), mail);
    if (!sent.sent) {
      door.logRefusal({ reason: "code_resend_too_soon", id: idTail(r.cdId), connection: ip });
      return reply.code(429).send({ error: "too_soon", retryInSeconds: Math.ceil(sent.retryInMs / 1000), detail: "We've sent a few already. Give it a few minutes, then try again." });
    }
    return { ok: true, sent: sent.delivery !== "failed" };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/email/verify", async (req, reply) => {
    const ip = clientIp(req);
    const r = await enrolling(req.params.ref, ip);
    if (!r.found) return reply.code(r.status).send(r.body);
    const parsed = codeBody.safeParse(req.body);
    const attempt = existingAttempt(req);
    if (!parsed.success || !attempt) return reply.code(400).send({ error: "invalid_request" });
    const result = await verifySignupCode(db, r.row.id, attempt, parsed.data.code);
    if (!result.ok) {
      door.fail(r.cdId, ip, `code_${result.error}`);
      return reply.code(result.status).send({ error: result.error, detail: DETAIL[result.error] });
    }
    setEnrolmentCookie(reply, result.token);
    return { ok: true, state: "verified", you: ownerDetails(r.row) };
  });
}
