/* Fresh step-up, owner authenticator, and recovery codes.
   Linking uses the five-minute marker this route sets. A backup code
   is not accepted here. */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { resolveSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { SIGN_IN_AUDIT, signInAuditDetail } from "../auth/signin-audit.js";
import { clientIp } from "../auth/client-ip.js";
import { anySignInFlag, readSignInFlags } from "../auth/signin-flags.js";
import { lockBody } from "../auth/signin-guard.js";
import {
  authenticatorPresent,
  beginOwnerTotp,
  confirmOwnerTotp,
  consumeStepUpCode,
  issueStepUpCode,
  markStepUp,
  noteFactorAttempt,
  passwordMatches,
  regenerateRecoveryCodes,
  stepUpFresh,
  verifyOwnerFactor,
} from "../auth/owner-mfa.js";
import { passkeyStepUpOptions, passkeyStepUpVerify, relyingParty } from "../auth/passkey-stepup.js";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const stepBody = z.object({
  password: z.string().min(1).max(512).optional(),
  totp: z.string().trim().regex(/^\d{6}$/).optional(),
  emailCode: z.string().trim().min(4).max(10).optional(),
}).strict();

export function registerStepUpRoutes(app: FastifyInstance, db: Db): void {
  async function who(req: { cookies: Record<string, string | undefined> }) {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await resolveSession(db, token) : null;
    if (!user || !token) return null;
    const row = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, user.id)).limit(1))[0];
    if (!row) return null;
    return { token, user: row };
  }

  function closed(reply: { code: (status: number) => { send: (body: unknown) => unknown } }) {
    if (anySignInFlag(readSignInFlags())) return false;
    reply.code(503).send({ error: "not_available" });
    return true;
  }

  app.post("/api/auth/stepup/email", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = z.object({ password: z.string().min(1).max(512) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!(await passwordMatches(session.user, parsed.data.password))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const issued = await issueStepUpCode(db, session.user, session.token);
    if (!issued.ok) return reply.code(409).send({ error: "no_address", detail: "This account has no email for a code." });
    return { ok: true };
  });

  app.post("/api/auth/stepup", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = stepBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.password) return reply.code(400).send({ error: "invalid_request" });
    if (!(await passwordMatches(session.user, parsed.data.password))) {
      await audit(db, {
        tenantId: session.user.tenantId,
        legalEntityId: session.user.legalEntityId,
        branchId: session.user.branchId,
        actorId: session.user.id,
        action: SIGN_IN_AUDIT.stepUpFailed,
        detail: signInAuditDetail({ method: "password", result: "fail", ip: clientIp(req), staffId: session.user.staffId, shop: session.user.tenantId }),
      });
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const strong = await authenticatorPresent(db, session.user.id, session.user.tenantId);
    let method = "password";
    if (strong) {
      if (!parsed.data.totp) return reply.code(403).send({ error: "factor_required", detail: "Use your authenticator or a passkey." });
      const factor = await verifyOwnerFactor(db, session.user, parsed.data.totp, clientIp(req));
      if (!factor.ok && factor.error === "locked") return reply.code(429).send(lockBody(factor.locked, "UTC"));
      if (!factor.ok || factor.factor !== "totp") return reply.code(401).send({ error: "invalid_credentials" });
      method = "totp";
    } else if (parsed.data.emailCode) {
      const ok = await consumeStepUpCode(db, session.user, session.token, parsed.data.emailCode);
      if (!ok) return reply.code(401).send({ error: "invalid_credentials" });
      method = "email";
    }
    await markStepUp(db, session.token);
    await audit(db, {
      tenantId: session.user.tenantId,
      legalEntityId: session.user.legalEntityId,
      branchId: session.user.branchId,
      actorId: session.user.id,
      action: SIGN_IN_AUDIT.stepUp,
      detail: signInAuditDetail({
        method,
        result: "ok",
        ip: clientIp(req),
        staffId: session.user.staffId,
        shop: session.user.tenantId,
      }),
    });
    return { ok: true };
  });

  app.post("/api/auth/stepup/passkey/options", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const gate = await noteFactorAttempt(db, session.user, clientIp(req), false, "passkey");
    if (!gate.ok) return reply.code(429).send(lockBody(gate.locked, "UTC"));
    const rp = relyingParty();
    if (!rp) return reply.code(503).send({ error: "not_available" });
    const options = await passkeyStepUpOptions(db, session.user.id, session.user.tenantId, rp, sha256(session.token));
    if (!options) return reply.code(404).send({ error: "not_found" });
    return options;
  });

  app.post("/api/auth/stepup/passkey/verify", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const rp = relyingParty();
    if (!rp) return reply.code(503).send({ error: "not_available" });
    const response = req.body as AuthenticationResponseJSON;
    if (!response || typeof response !== "object" || !response.id) return reply.code(400).send({ error: "invalid_request" });
    const ok = await passkeyStepUpVerify(db, session.user.id, session.user.tenantId, rp, sha256(session.token), response);
    if (!ok) {
      const gate = await noteFactorAttempt(db, session.user, clientIp(req), false, "passkey");
      if (!gate.ok) return reply.code(429).send(lockBody(gate.locked, "UTC"));
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await markStepUp(db, session.token);
    return { ok: true };
  });

  app.post("/api/auth/mfa/enroll/start", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await stepUpFresh(db, session.token))) return reply.code(403).send({ error: "step_up_required" });
    const started = await beginOwnerTotp(db, session.user, session.token);
    if (!started.ok) return reply.code(started.error === "not_owner" ? 403 : 409).send({ error: started.error });
    return {
      ok: true,
      ticket: started.ticket,
      otpauthUri: started.otpauthUri,
      manualSecret: started.manualSecret,
      backupCodes: started.backupCodes,
    };
  });

  app.post("/api/auth/mfa/enroll/confirm", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = z.object({ ticket: z.string().min(10).max(200), code: z.string().trim().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await confirmOwnerTotp(db, session.user, session.token, parsed.data.ticket, parsed.data.code, clientIp(req));
    if (result === true) return { ok: true };
    if (result.error === "already_enrolled") return reply.code(409).send({ error: "already_enrolled" });
    if (result.error === "locked") return reply.code(429).send(lockBody(result.locked, "UTC"));
    return reply.code(401).send({ error: "invalid_credentials" });
  });

  app.post("/api/auth/mfa/recovery", async (req, reply) => {
    if (closed(reply)) return;
    const session = await who(req);
    if (!session) return reply.code(401).send({ error: "unauthenticated" });
    if (!(await stepUpFresh(db, session.token))) return reply.code(403).send({ error: "step_up_required" });
    const codes = await regenerateRecoveryCodes(db, session.user);
    if (!codes) return reply.code(403).send({ error: "not_available" });
    return { ok: true, backupCodes: codes };
  });
}
