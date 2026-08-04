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
import { createSession, resolveSession, resolveSessionState, revokeAllSessions, revokeSession, SESSION_COOKIE } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { looksLikeCdId, normalizeCdId } from "../auth/cdid.js";
import { tenantPlan } from "./tenant.js";
import { makeCode, hashCode, codeMatches, sendEmail, loginCodeEmail, passwordResetEmail } from "../email.js";
import { randomUUID } from "node:crypto";
import { waitBefore, sent as markSent, tooSoon } from "../cooldown.js";

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

const forgotBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(160),
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});
const resetBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(160),
  code: z.string().trim().min(4).max(10),
  newPassword: z.string().min(8, "password: at least 8 characters").max(512),
  tenantId: z.string().min(1).max(120).default("tnt-yorkfx"),
});

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/* Asking for a reset has to be cheap for the person who forgot and
   expensive for anybody working through a list. Counted per address AND
   per caller: throttling only by address lets somebody sweep a thousand of
   them, and throttling only by caller lets a botnet hammer one. */
const resetAsks = new Map<string, number[]>();
const RESET_WINDOW_MS = 60 * 60 * 1000;
function askedTooOften(key: string, max: number): boolean {
  const now = Date.now();
  const hits = (resetAsks.get(key) ?? []).filter((t) => now - t < RESET_WINDOW_MS);
  if (hits.length >= max) return true;
  hits.push(now);
  resetAsks.set(key, hits);
  for (const [k, v] of resetAsks) if (!v.some((t) => now - t < RESET_WINDOW_MS)) resetAsks.delete(k);
  return false;
}
const RESET_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
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

    /* Anyone whose staff id is an email gets a code sent to it, and that code
       is the second factor. This endpoint predates it and grants a session on
       the password alone — so left open it is a way to walk straight past the
       code. Refuse them here; /api/auth/login/start is the door.

       Staff ids that are not addresses keep working: there is nowhere to send
       a code, so the password is the only factor either way, and login/start
       treats them identically. */
    if (isEmail(user.staffId)) {
      return reply.code(403).send({
        error: "code_required",
        detail: "This account signs in with an emailed code. Start at /api/auth/login/start.",
      });
    }

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
    /* A CurrencyDesk ID identifies a person on its own — that is the point of
       it — so it resolves without being told which desk. */
    if (looksLikeCdId(staffId)) {
      const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.cdId, normalizeCdId(staffId))).limit(1);
      return rows[0];
    }
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
    /* Pressing "Send my code" twice used to send two, and only the second
       one worked — so the code somebody read off the first email was the
       one that failed. The password was already proved above, so refusing
       here tells them nothing they did not know a moment ago. */
    const wait = waitBefore("login:" + user.id);
    if (wait) return reply.code(429).send(tooSoon(wait));

    const code = makeCode();
    loginChallenges.set(user.id, { codeHash: hashCode(code), expiresAt: Date.now() + CHALLENGE_TTL_MS, attempts: 0 });
    const mail = loginCodeEmail(code, user.name);
    await sendEmail(recipient, mail.subject, { text: mail.text, html: mail.html });
    markSent("login:" + user.id);
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

  /* ---- forgot password -------------------------------------------------

     There was no way back from a forgotten password. The sign-in screen
     told the owner "the owner can reset it" — and the owner is the owner —
     so the only working path was a phone call to us, and somebody reading
     a temporary password down the line.

     Two rules make this safe, and both are easy to get wrong.

     THE ANSWER IS THE SAME EITHER WAY. Whether or not that address has an
     account, this route says the same thing in the same time. Otherwise
     the form is a way to ask "does this shop bank with CurrencyDesk?" and
     get a straight answer, one address at a time.

     A RESET KILLS EVERY SESSION. Changing the password while whoever
     prompted the reset stays signed in is theatre. Every device is signed
     out, including the one doing the resetting — they sign in with the new
     password, which is also the proof it took. */
  app.post("/api/auth/forgot", async (req, reply) => {
    const parsed = forgotBody.safeParse(req.body);
    // even a malformed address gets the same shrug
    if (!parsed.success) return { ok: true };
    const { email, tenantId } = parsed.data;

    /* Refused the same way for everyone, so the throttle cannot be read as
       "this address exists". */
    if (askedTooOften("ip:" + req.ip, 20) || askedTooOften("addr:" + email, 5)) {
      return reply.code(429).send({
        error: "slow_down",
        detail: "Too many requests. Wait a few minutes and try again.",
      });
    }

    const user = await findLoginUser(email, tenantId);
    /* Only somebody who signs in with an address can be sent a code. A desk
       that signs its people in as "a.rostami" has nowhere to send one, and
       says so through the same silent answer. */
    /* The gap is checked BEFORE we know whether this address exists, and
       answers the same way regardless, so it cannot be read as "yes, there
       is an account here". */
    const wait = waitBefore("reset:" + email);
    if (wait) return reply.code(429).send(tooSoon(wait));

    if (user && user.active && isEmail(user.staffId) && !(await tenantSuspended(user.tenantId))) {
      const code = makeCode();
      // one live reset per person: the last one stops working now
      await db.delete(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id));
      await db.insert(schema.passwordResets).values({
        id: randomUUID(), userId: user.id, codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      const mail = passwordResetEmail(code, user.name, Math.round(RESET_TTL_MS / 60000));
      await sendEmail(user.staffId, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
      await audit(db, {
        tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId,
        actorId: user.id, action: "auth.reset_requested",
      });
    }
    /* Marked whether or not anything was sent — otherwise the cooldown
       itself becomes the tell: a second ask that goes through instantly
       means "no account", and one that is refused means "there is". */
    markSent("reset:" + email);
    /* Deliberately says nothing about whether that landed. */
    return { ok: true };
  });

  app.post("/api/auth/reset", async (req, reply) => {
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { email, code, newPassword, tenantId } = parsed.data;

    const user = await findLoginUser(email, tenantId);
    const row = user
      ? (await db.select().from(schema.passwordResets).where(eq(schema.passwordResets.userId, user.id)).limit(1))[0]
      : undefined;

    /* One answer for "no such person", "never asked", "already used" and
       "wrong code". Each of those is a different fact about somebody else's
       account and none of them is this caller's business. */
    const refuse = () => reply.code(401).send({
      error: "bad_code",
      detail: "That code is not right, or it has expired. Ask for a new one.",
    });
    if (!user || !row || row.usedAt) return refuse();
    if (row.expiresAt.getTime() < Date.now()) {
      await db.delete(schema.passwordResets).where(eq(schema.passwordResets.id, row.id));
      return refuse();
    }
    if (row.attempts >= RESET_MAX_ATTEMPTS) {
      await db.delete(schema.passwordResets).where(eq(schema.passwordResets.id, row.id));
      return refuse();
    }
    if (!codeMatches(code, row.codeHash)) {
      /* Counted, and this is what makes six digits enough: the code dies on
         the fifth wrong guess, so a million-wide space is never walked. */
      await db.update(schema.passwordResets).set({ attempts: row.attempts + 1 }).where(eq(schema.passwordResets.id, row.id));
      return refuse();
    }

    await db.update(schema.staffUsers)
      .set({ passwordHash: await hashPassword(newPassword), mustChangePassword: false, passwordUpdatedAt: new Date() })
      .where(eq(schema.staffUsers.id, user.id));
    await db.delete(schema.passwordResets).where(eq(schema.passwordResets.id, row.id));
    // every device, including whoever prompted this
    await revokeAllSessions(db, user.id);
    await audit(db, {
      tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId,
      actorId: user.id, action: "auth.reset_completed",
    });
    return { ok: true, signInAs: user.staffId };
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
    /* A blocked desk's sessions stop working everywhere (see
       auth/sessions.ts), and everywhere else that reads as a plain 401. On
       the one call the OS makes to find out who it is talking to, say which
       of the two it is — otherwise a suspended desk looks to its owner like
       a browser that forgot them, and they ring up about the wrong thing. */
    const resolved = await resolveSessionState(db, req.cookies[SESSION_COOKIE]);
    if (resolved.state === "suspended") {
      return reply.code(403).send({ error: "suspended", detail: "This desk is suspended — contact CurrencyDesk." });
    }
    const who = resolved.state === "active" ? resolved.user : null;
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
