/* ============================================================
   Sign-up v2.1, chapter 1: "How will you sign in?" (SIGNUP-LOGIC §3.1).

     POST /api/onboarding/:id/passkey/options
     POST /api/onboarding/:id/passkey/verify
     GET  /api/onboarding/:id/sso/:provider/start
     POST /api/onboarding/:id/sso/callback
     POST /api/onboarding/:id/password

   Each saves a CANDIDATE credential for this browser's attempt and moves
   the account reserved → enrolling (onboarding/signup-account.ts). None of
   them says anything about the owner: no name, no email, not even whether
   the reservation email is a Google account. The email code (PR 3) is what
   makes a candidate the owner's.

   Refused once the email code has passed (more ways in are added inside,
   Settings › My account) and once the desk is open ("sign in instead").
   ============================================================ */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { audit } from "../audit.js";
import { PLATFORM_TENANT } from "../admin-bootstrap.js";
import { clientIp } from "../auth/client-ip.js";
import { hashSignupSecret } from "../auth/password.js";
import { normalizeCdIdInput } from "../enquiries/cd-id.js";
import { idTail, operatingNameOf, type IdDoor } from "../onboarding/cd-id-door.js";
import { attemptOf, existingAttempt, loadAccount, saveCredential, takesCredential, type Account } from "../onboarding/signup-account.js";
import { passkeyOptions, relyingParty, verifyPasskey } from "../onboarding/passkey.js";
import { checkPassword, pwnedRange, type RangeFetch } from "../onboarding/password-rule.js";
import { PROVIDERS, fetchJson, finishSso, providerConfig, startSso, type FetchJson, type Provider } from "../onboarding/sso.js";
import { sendSignupCode, type Mailer } from "../onboarding/email-code.js";
import { sendEmail } from "../email.js";

type Enquiry = typeof schema.enquiries.$inferSelect;
type Reservation = { cdId: string; row: Enquiry; account: Account; connection: string };

export type CredentialDeps = { breachRange?: RangeFetch; http?: FetchJson; env?: NodeJS.ProcessEnv; mail?: Mailer };

const b64url = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);
const passkeyBody = z.object({
  response: z.object({
    id: b64url, rawId: b64url, type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: b64url, attestationObject: b64url,
      transports: z.array(z.string().max(20)).max(8).optional(),
    }).passthrough(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  }),
  deviceLabel: z.string().trim().max(60).optional(),
});
const ssoBody = z.object({ provider: z.enum(["google", "microsoft"]), code: z.string().min(1).max(2048), state: z.string().min(16).max(128) });
const passwordBody = z.object({ password: z.string().min(1).max(1024), confirm: z.string().min(1).max(1024) });

export function registerCredentialRoutes(app: FastifyInstance, db: Db, door: IdDoor, deps: CredentialDeps = {}): void {
  const env = deps.env ?? process.env;
  const http = deps.http ?? fetchJson;
  const breachRange = deps.breachRange ?? pwnedRange;
  const mail = deps.mail ?? sendEmail;

  /* The moment a credential is saved, the code goes to the email on file
     (§3.2). A send refused for coming too soon still leaves the credential
     saved; the inbox screen offers "Send it again" when the wait is over. */
  async function codeAfterSave(r: Reservation): Promise<boolean> {
    const result = await sendSignupCode(db, r.row, operatingNameOf(r.row), mail);
    return result.sent && result.delivery !== "failed";
  }

  /* The reservation this ID names, if it still takes a credential. Replies
     (404 / 409 / 429) and returns undefined otherwise. */
  async function reservation(req: FastifyRequest<{ Params: { ref: string } }>, reply: FastifyReply): Promise<Reservation | undefined> {
    const connection = clientIp(req);
    const cdId = normalizeCdIdInput(req.params.ref);
    if (!cdId) { reply.code(404).send({ error: "no_such_id" }); return undefined; }
    if (door.closed(cdId, connection)) { reply.code(429).send({ error: "slow_down" }); return undefined; }
    const row = await door.findByCdId(cdId);
    if (!row) {
      door.fail(cdId, connection, "credential_unknown_id");
      reply.code(404).send({ error: "no_such_id" });
      return undefined;
    }
    const account = await loadAccount(db, row.id);
    if (row.status === "accepted" || account.state === "active") {
      door.logRefusal({ reason: "already_open", id: idTail(cdId), connection });
      reply.code(409).send({ error: "already_open", detail: "This desk is already open. Sign in." });
      return undefined;
    }
    if (!takesCredential(account.state)) {
      door.logRefusal({ reason: "already_verified", id: idTail(cdId), connection });
      reply.code(409).send({ error: "already_verified", detail: "Your sign-in is already set. Carry on where you left off." });
      return undefined;
    }
    return { cdId, row, account, connection };
  }

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/passkey/options", async (req, reply) => {
    const r = await reservation(req, reply);
    if (!r) return;
    const rp = relyingParty(env);
    if (!rp) return reply.code(503).send({ error: "passkey_unavailable", detail: "Passkeys aren't configured here yet. Choose another way." });
    const options = await passkeyOptions(db, rp, {
      enquiryId: r.row.id, accountId: r.account.accountId, cdId: r.cdId, operatingName: operatingNameOf(r.row), attemptHash: attemptOf(req, reply),
    });
    return { options };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/passkey/verify", async (req, reply) => {
    const r = await reservation(req, reply);
    if (!r) return;
    const parsed = passkeyBody.safeParse(req.body);
    const attempt = existingAttempt(req);
    if (!parsed.success || !attempt) return reply.code(400).send({ error: "invalid_request" });
    /* zod has checked every field the library reads; the type is the library's. */
    const response = parsed.data.response as unknown as RegistrationResponseJSON;
    const rp = relyingParty(env);
    if (!rp) return reply.code(503).send({ error: "passkey_unavailable" });
    const result = await verifyPasskey(db, rp, { enquiryId: r.row.id, attemptHash: attempt, response });
    if (!result.ok) {
      door.fail(r.cdId, r.connection, `passkey_${result.reason}`);
      return reply.code(400).send({ error: "passkey_not_saved", detail: "The passkey wasn't created. Nothing was saved. Try again, or choose another way." });
    }
    const saved = await saveCredential(db, r.row.id, {
      kind: "passkey", attemptHash: attempt, passkey: { ...result.passkey, deviceLabel: parsed.data.deviceLabel || "This device" },
    });
    if (!saved) return reply.code(409).send({ error: "already_verified" });
    return { ok: true, kind: "passkey", state: saved.state, codeSent: await codeAfterSave(r) };
  });

  app.get<{ Params: { ref: string; provider: string } }>("/api/onboarding/:ref/sso/:provider/start", async (req, reply) => {
    const provider = PROVIDERS.find((p) => p === req.params.provider);
    if (!provider) return reply.code(404).send({ error: "no_such_provider" });
    const cfg = providerConfig(provider, env);
    if (!cfg) return reply.code(503).send({ error: "sso_unavailable", detail: "That way in isn't available yet. Choose another." });
    const r = await reservation(req, reply);
    if (!r) return;
    return { url: await startSso(db, cfg, { enquiryId: r.row.id, attemptHash: attemptOf(req, reply) }) };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/sso/callback", async (req, reply) => {
    const parsed = ssoBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const provider: Provider = parsed.data.provider;
    const cfg = providerConfig(provider, env);
    if (!cfg) return reply.code(503).send({ error: "sso_unavailable" });
    const r = await reservation(req, reply);
    if (!r) return;
    const attempt = existingAttempt(req);
    if (!attempt) return reply.code(400).send({ error: "invalid_request" });
    const result = await finishSso(db, cfg, { enquiryId: r.row.id, attemptHash: attempt, code: parsed.data.code, state: parsed.data.state, ownerEmail: r.row.email }, http);
    if (!result.ok) {
      door.fail(r.cdId, r.connection, `sso_${result.reason}`);
      if (result.reason === "email_mismatch" || result.reason === "email_unverified") {
        await audit(db, {
          tenantId: PLATFORM_TENANT, legalEntityId: "-", branchId: "-",
          action: "sso.refused_mismatch", detail: { enquiryId: r.row.id, provider, reason: result.reason },
        });
        const label = provider === "google" ? "Google" : "Microsoft";
        return reply.code(409).send({ error: "email_mismatch", detail: `That ${label} account isn't the email you applied with. Use the account for that email.` });
      }
      if (result.reason === "provider_unavailable") {
        return reply.code(502).send({ error: "sso_unavailable", detail: "We couldn't reach that sign-in just now. Try again, or choose another way." });
      }
      return reply.code(400).send({ error: "sso_not_saved", detail: "That sign-in didn't finish. Nothing was saved. Try again, or choose another way." });
    }
    const saved = await saveCredential(db, r.row.id, { kind: provider, attemptHash: attempt, sso: { subject: result.subject, tenant: result.tenant } });
    if (!saved) return reply.code(409).send({ error: "already_verified" });
    return { ok: true, kind: provider, state: saved.state, codeSent: await codeAfterSave(r) };
  });

  app.post<{ Params: { ref: string } }>("/api/onboarding/:ref/password", async (req, reply) => {
    const r = await reservation(req, reply);
    if (!r) return;
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.password !== parsed.data.confirm) {
      return reply.code(422).send({ error: "password_mismatch", detail: "Those two don't match. Type it again." });
    }
    const verdict = await checkPassword(parsed.data.password, operatingNameOf(r.row), breachRange);
    if (!verdict.ok) {
      door.logRefusal({ reason: `password_${verdict.reason}`, id: idTail(r.cdId), connection: r.connection });
      return reply.code(verdict.reason === "check_unavailable" ? 503 : 422).send({ error: `password_${verdict.reason}`, detail: verdict.detail });
    }
    const saved = await saveCredential(db, r.row.id, {
      kind: "password", attemptHash: attemptOf(req, reply), passwordHash: await hashSignupSecret(parsed.data.password),
    });
    if (!saved) return reply.code(409).send({ error: "already_verified" });
    return { ok: true, kind: "password", state: saved.state, codeSent: await codeAfterSave(r) };
  });
}
