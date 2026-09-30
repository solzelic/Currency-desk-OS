/* Platform-operator sign-in at /admin.

     POST /api/admin/login         { staffId, password }
       → { step: "enroll", ticket, otpauthUri, manualSecret, backupCodes }
         or { step: "totp", ticket }
       No session cookie. The secret and the backup codes are in this
       response and nowhere else — not in the log, not again on the next
       sign-in.
     POST /api/admin/login/enroll  { ticket, code }
       A code from the authenticator saves the factor and opens the panel.
     POST /api/admin/login/totp    { ticket, code }
       A current code, or a backup code that has not been used yet.

   Desk staff never reach a session here. A correct desk password is the
   same 401 as a wrong one: this door is not a way to ask whether a till
   login exists. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { verifyPassword } from "../auth/password.js";
import { findStaffForLogin } from "../auth/login-user.js";
import { member } from "../platform/team.js";
import {
  beginPlatformMfa,
  confirmPlatformEnrollment,
  confirmPlatformLogin,
  type MfaFailure,
} from "../auth/platform-mfa.js";
import { createSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";

const passwordBody = z.object({
  staffId: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(512),
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});

const codeBody = z.object({
  ticket: z.string().trim().min(20).max(200),
  code: z.string().trim().min(6).max(64),
});

const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

function failureStatus(error: MfaFailure): { status: number; body: { error: string; detail: string } } {
  switch (error) {
    case "expired":
      return { status: 410, body: { error: "expired", detail: "That sign-in expired. Start again." } };
    case "no_challenge":
      return { status: 410, body: { error: "no_challenge", detail: "Start sign-in again." } };
    case "too_many_attempts":
      return { status: 429, body: { error: "too_many_attempts", detail: "Too many tries. Start sign-in again." } };
    case "already_enrolled":
      return { status: 409, body: { error: "already_enrolled", detail: "An authenticator is already set up. Sign in with a code." } };
    case "wrong_code":
      return { status: 401, body: { error: "wrong_code", detail: "That code isn't right." } };
  }
}

export function registerAdminMfaRoutes(app: FastifyInstance, db: Db) {
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };

  async function openSession(email: string, factor: "totp" | "backup" | "enroll") {
    const staff = await findStaffForLogin(db, email, "tnt-platform");
    if (!staff?.active) return null;
    const { token, expiresAt } = await createSession(db, staff.id, { platformMfa: true });
    await audit(db, {
      tenantId: staff.tenantId,
      legalEntityId: staff.legalEntityId,
      branchId: staff.branchId,
      actorId: staff.id,
      action: factor === "enroll" ? "auth.mfa_enrolled" : "auth.login",
      detail: { factor: factor === "enroll" ? "totp" : factor },
    });
    if (factor === "enroll") {
      await audit(db, {
        tenantId: staff.tenantId,
        legalEntityId: staff.legalEntityId,
        branchId: staff.branchId,
        actorId: staff.id,
        action: "auth.login",
        detail: { factor: "totp" },
      });
    }
    return { staff, token, expiresAt };
  }

  async function noteFailure(email: string | undefined, step: "enroll" | "login") {
    if (!email) return;
    const staff = await findStaffForLogin(db, email, "tnt-platform");
    if (!staff) return;
    await audit(db, {
      tenantId: staff.tenantId,
      legalEntityId: staff.legalEntityId,
      branchId: staff.branchId,
      actorId: staff.id,
      action: "auth.mfa_failed",
      detail: { step },
    });
  }

  app.post("/api/admin/login", async (req, reply) => {
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { staffId, password, tenantId } = parsed.data;
    const user = await findStaffForLogin(db, staffId, tenantId);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.active || !ok) {
      if (user) {
        await audit(db, {
          tenantId: user.tenantId,
          legalEntityId: user.legalEntityId,
          branchId: user.branchId,
          actorId: user.id,
          action: "auth.login_failed",
        });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const me = await member(db, user.staffId);
    if (!me) return reply.code(401).send({ error: "invalid_credentials" });
    try {
      return await beginPlatformMfa(db, me.email);
    } catch {
      req.log.error("platform mfa could not start");
      return reply.code(500).send({ error: "unavailable" });
    }
  });

  app.post("/api/admin/login/enroll", async (req, reply) => {
    const parsed = codeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await confirmPlatformEnrollment(db, parsed.data.ticket, parsed.data.code);
    if (!result.ok) {
      await noteFailure(result.email, "enroll");
      const failure = failureStatus(result.error);
      return reply.code(failure.status).send(failure.body);
    }
    const opened = await openSession(result.value.email, "enroll");
    if (!opened) return reply.code(401).send({ error: "invalid_credentials" });
    reply.setCookie(SESSION_COOKIE, opened.token, { ...cookieOpts, expires: opened.expiresAt });
    return { ok: true };
  });

  app.post("/api/admin/login/totp", async (req, reply) => {
    const parsed = codeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const result = await confirmPlatformLogin(db, parsed.data.ticket, parsed.data.code);
    if (!result.ok) {
      await noteFailure(result.email, "login");
      const failure = failureStatus(result.error);
      return reply.code(failure.status).send(failure.body);
    }
    const opened = await openSession(result.value.email, result.value.factor);
    if (!opened) return reply.code(401).send({ error: "invalid_credentials" });
    reply.setCookie(SESSION_COOKIE, opened.token, { ...cookieOpts, expires: opened.expiresAt });
    return { ok: true };
  });
}
