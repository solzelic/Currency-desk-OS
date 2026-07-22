/* ============================================================
   Auth routes
     POST /api/auth/login            { staffId, password } → session cookie + user
     POST /api/auth/logout           → revokes the session
     GET  /api/auth/me               → current user + scope (or 401)
     POST /api/auth/change-password  { currentPassword, newPassword }
       — self-service; proves the current password, clears the
         must-change flag, and revokes every OTHER session.
   Login answers are deliberately uniform ("invalid credentials")
   so staff IDs can't be enumerated; every attempt is audited.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { createSession, resolveSession, revokeAllSessions, revokeSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { tenantPlan } from "./tenant.js";
import { makeCode, hashCode, codeMatches, sendEmail, loginCodeEmail } from "../email.js";

const loginBody = z.object({
  staffId: z.string().min(1).max(120),
  password: z.string().min(1).max(512),
  // multi-tenant login: which house. Defaults to the demo tenant for now;
  // production resolves this from the subdomain / device enrolment.
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(8, "password: at least 8 characters").max(512),
});
const verifyLoginBody = z.object({
  staffId: z.string().min(1).max(120),
  code: z.string().trim().min(4).max(10),
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
// short-lived in-memory sign-in challenges — a restart just asks the user to
// sign in again, and Render runs one instance. key = staff user id.
const loginChallenges = new Map<string, { codeHash: string; expiresAt: number; attempts: number }>();
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MAX_ATTEMPTS = 5;
const maskEmail = (e: string) => { const [u, d] = e.split("@"); return ((u && u[0]) || "") + "••••@" + (d || ""); };
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

export function registerAuthRoutes(app: FastifyInstance, db: Db) {
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
  // a platform-suspended desk can't sign in
  const tenantSuspended = async (tenantId: string) => {
    const r = await db.select({ s: schema.tenants.suspended }).from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
    return !!r[0]?.s;
  };

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { staffId, password, tenantId } = parsed.data;

    const users = await db
      .select()
      .from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, staffId)))
      .limit(1);
    const user = users[0];

    // verify against a constant dummy hash when the user is unknown so the
    // response time doesn't reveal whether the staff ID exists
    const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY);

    if (!user || !user.active || !ok) {
      if (user) {
        await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login_failed" });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (await tenantSuspended(user.tenantId)) return reply.code(403).send({ error: "suspended", detail: "This desk is suspended — contact CurrencyDesk." });

    const { token, expiresAt } = await createSession(db, user.id);
    await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });

    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    return {
      user: {
        id: user.staffId,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        authorizedBranchIds: user.authorizedBranchIds,
        mustChangePassword: user.mustChangePassword,
        plan: await tenantPlan(db, user.tenantId),
      },
    };
  });

  // shared response shape for a signed-in user
  const userPayload = async (user: typeof schema.staffUsers.$inferSelect) => ({
    id: user.staffId,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
    legalEntityId: user.legalEntityId,
    branchId: user.branchId,
    authorizedBranchIds: user.authorizedBranchIds,
    mustChangePassword: user.mustChangePassword,
    plan: await tenantPlan(db, user.tenantId),
  });
  // resolve a staff user by staff id — an email identity is globally unique so
  // it resolves the tenant on its own; a plain staff id is scoped by tenant.
  async function findLoginUser(staffId: string, tenantId: string) {
    if (isEmail(staffId)) {
      const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId)).limit(2);
      if (rows.length === 1) return rows[0];
      if (rows.length > 1) return rows.find((r) => r.tenantId === tenantId) ?? rows[0];
      return undefined;
    }
    const rows = await db.select().from(schema.staffUsers).where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, staffId))).limit(1);
    return rows[0];
  }

  // Step 1 of an email-verified sign-in: prove the password, then email a code.
  // Users without an email on file (e.g. seeded staff ids) sign in on the
  // password alone — there's nowhere to send a code.
  app.post("/api/auth/login/start", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { staffId, password, tenantId } = parsed.data;
    const user = await findLoginUser(staffId, tenantId);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !user.active || !ok) {
      if (user) await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login_failed" });
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (await tenantSuspended(user.tenantId)) return reply.code(403).send({ error: "suspended", detail: "This desk is suspended — contact CurrencyDesk." });
    const recipient = isEmail(user.staffId) ? user.staffId : null;
    if (!recipient) {
      // no address to verify — password is the only factor
      const { token, expiresAt } = await createSession(db, user.id);
      await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
      return { ok: true, needsCode: false, user: await userPayload(user) };
    }
    const code = makeCode();
    loginChallenges.set(user.id, { codeHash: hashCode(code), expiresAt: Date.now() + CHALLENGE_TTL_MS, attempts: 0 });
    const mail = loginCodeEmail(code, user.name);
    await sendEmail(recipient, mail.subject, { text: mail.text, html: mail.html });
    return { ok: true, needsCode: true, maskedEmail: maskEmail(recipient), user: { id: user.staffId, name: user.name, role: user.role, tenantId: user.tenantId, mustChangePassword: user.mustChangePassword } };
  });

  // Step 2: the emailed code grants the session.
  app.post("/api/auth/login/verify", async (req, reply) => {
    const parsed = verifyLoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { staffId, code, tenantId } = parsed.data;
    const user = await findLoginUser(staffId, tenantId);
    if (!user) return reply.code(401).send({ error: "invalid_credentials" });
    const ch = loginChallenges.get(user.id);
    if (!ch) return reply.code(410).send({ error: "no_challenge", detail: "Start sign-in again." });
    if (ch.expiresAt < Date.now()) { loginChallenges.delete(user.id); return reply.code(410).send({ error: "expired", detail: "That code expired — sign in again." }); }
    if (ch.attempts >= CHALLENGE_MAX_ATTEMPTS) { loginChallenges.delete(user.id); return reply.code(429).send({ error: "too_many_attempts", detail: "Too many tries — sign in again." }); }
    if (!codeMatches(code, ch.codeHash)) {
      ch.attempts += 1;
      return reply.code(401).send({ error: "wrong_code", detail: "That code isn't right — check your email." });
    }
    loginChallenges.delete(user.id);
    const { token, expiresAt } = await createSession(db, user.id);
    await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    return { user: await userPayload(user) };
  });

  app.post("/api/auth/change-password", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await resolveSession(db, token);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    const parsed = changePasswordBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });

    const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, who.id)).limit(1);
    const user = rows[0];
    if (!user) return reply.code(401).send({ error: "unauthenticated" });
    const ok = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!ok) {
      await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "auth.password_change_failed" });
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    await db
      .update(schema.staffUsers)
      .set({ passwordHash: await hashPassword(parsed.data.newPassword), mustChangePassword: false, passwordUpdatedAt: new Date() })
      .where(eq(schema.staffUsers.id, who.id));
    // new password invalidates every other device; this session stays alive
    await revokeAllSessions(db, who.id, token);
    await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "auth.password_changed" });
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await resolveSession(db, token);
    await revokeSession(db, token);
    if (who) {
      await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "auth.logout" });
    }
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    return {
      user: {
        id: who.staffId,
        name: who.name,
        role: who.role,
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: who.branchId,
        authorizedBranchIds: who.authorizedBranchIds,
        mustChangePassword: who.mustChangePassword,
        plan: await tenantPlan(db, who.tenantId),
      },
    };
  });
}
