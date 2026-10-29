/* ============================================================
   Auth routes
     POST /api/auth/login            { staffId, password } → session cookie + user
     POST /api/auth/switch           { staffId, pin } → revoke this session, cookie for them
     POST /api/auth/logout           → revokes the session
     GET  /api/auth/me               → current user + scope (or 401)
     POST /api/auth/change-password  { currentPassword, newPassword }
       — self-service; proves the current password, clears the
         must-change flag, and revokes every OTHER session.
   Login answers are deliberately uniform ("invalid credentials")
   so staff IDs can't be enumerated; every attempt is audited.
   Password guesses are counted in Postgres (see auth/signin-guard.ts):
   five on the account or twenty from one address, then the same
   "Too many tries" sentence for a real id and an unknown one.
   The emailed-code step uses that same sentence for an unknown id
   and a wrong code, and it will not compare a code until this browser
   has a server-side marker that the password step passed.
   Platform-operator TOTP is a different door (/api/admin/login). This
   file stays the desk: a staff id that is not an email is password-only.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { isStagingRuntime, type StagingDoorHeaders } from "../auth/staging-runtime.js";
import { stagingTestOwnerOnScreen } from "./staging-fresh-shop.js";
import { createSession, replaceSession, resolveSession, resolveSessionState, revokeAllSessions, revokeSession, SessionReplacedError, sessionIsRevoked, SESSION_COOKIE } from "../auth/sessions.js";
import { clearStagingCookie, STAGING_COOKIE } from "./staging-signin.js";
import { pinDeskName } from "../auth/desk-name.js";
import { clearPinAttempts, lockState, reservePinAttempt } from "./pin.js";
import { audit } from "../audit.js";
import { findStaffForLogin, isEmail } from "../auth/login-user.js";
import { tenantPlan } from "./tenant.js";
import { makeCode, hashCode, codeMatches, sendEmail, loginCodeEmail, passwordResetEmail } from "../email.js";
import pg from "pg";
import { attachPoolErrorHandler } from "../db/pool-error.js";
import { randomUUID } from "node:crypto";
import { waitBefore, sent as markSent, tooSoon } from "../cooldown.js";
import { clientIp } from "../auth/client-ip.js";
import {
  CODE_REFUSAL,
  DUMMY_CODE_HASH,
  LOGIN_PROOF_COOKIE,
  accountKeyFor,
  clearSignInLock,
  createLoginProof,
  deleteLoginProof,
  judgeSignIn,
  loadLoginProof,
  lockBody,
  noteWrongCode,
  staffMatches,
  type SignInDecision,
} from "../auth/signin-guard.js";

const loginBody = z.object({
  staffId: z.string().min(1).max(120),
  password: z.string().min(1).max(512),
  /* Which house. The desk's sign-in screen does not say: then the name is
     looked up at the demo desk and, failing that, on every desk, because a
     username carries its shop (auth/login-user.ts). A caller that names a
     desk gets that desk only. */
  tenantId: z.string().min(1).max(120).optional(),
});
const DEFAULT_LOGIN_TENANT = "tnt-yorkfx";

const switchBody = z.object({
  staffId: z.string().min(1).max(120),
  pin: z.string().regex(/^\d{4}$/, "pin: four digits"),
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
const maskEmail = (e: string) => { const [u, d] = e.split("@"); return ((u && u[0]) || "") + "••••@" + (d || ""); };

/* A manager, an auditor, or compliance may sit on a till they did not
   count, to look or to approve. They do not become its owner. */
const TILL_VIEWER = new Set(["branch_manager", "administrator", "auditor", "compliance_officer"]);

export function registerAuthRoutes(app: FastifyInstance, db: Db) {
  const ledgerUrl = process.env.LEDGER_DATABASE_URL ?? process.env.DATABASE_URL;
  const ledger = ledgerUrl ? new pg.Pool({ connectionString: ledgerUrl, max: 2 }) : null;
  if (ledger) attachPoolErrorHandler(ledger);
  if (ledger) app.addHook("onClose", async () => { await ledger.end(); });
  /* Who counted the till on this workspace. No open session means nobody.
     The ledger pool is the book when the app database is not. */
  const tillOpener = async (workspaceId: string): Promise<string | null> => {
    const text = `SELECT opened_by FROM ledger_till_sessions WHERE workspace_id = $1 AND status = 'open' ORDER BY session_number DESC LIMIT 1`;
    if (ledger) {
      const found = await ledger.query(text, [workspaceId]);
      return (found.rows[0]?.opened_by as string | undefined) ?? null;
    }
    const found = await db.execute(sql`SELECT opened_by FROM ledger_till_sessions WHERE workspace_id = ${workspaceId} AND status = 'open' ORDER BY session_number DESC LIMIT 1`);
    return (found.rows[0] as { opened_by?: string } | undefined)?.opened_by ?? null;
  };
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

  /* The clock on the lock screen is the branch's clock. The person's own
     branch when we know them; the desk's branch when the id is unknown,
     so the sentence does not change shape between the two. No zone is a
     thrown error. A UTC stand-in would show the wrong hour. */
  async function branchZone(user: typeof schema.staffUsers.$inferSelect | undefined, tenantId: string): Promise<string> {
    if (user) {
      const own = await db.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.id, user.branchId)).limit(1);
      const zone = own[0]?.timezone?.trim();
      if (zone) return zone;
    }
    const desk = await db.select({ timezone: schema.branches.timezone }).from(schema.branches).where(eq(schema.branches.tenantId, tenantId)).limit(1);
    const zone = desk[0]?.timezone?.trim();
    if (!zone) throw new Error("Sign-in lock has no branch time zone.");
    return zone;
  }

  /* One refusal for both doors. A lock and a wrong password are different
     sentences on purpose; a missing account and a real one are not.
     The audit row names the lock, never the password. */
  async function passwordRefusal(user: typeof schema.staffUsers.$inferSelect | undefined, decision: SignInDecision, tenantId: string) {
    if (decision.result === "pass") throw new Error("passwordRefusal called after the password matched.");
    if (user) {
      await audit(db, {
        tenantId: user.tenantId,
        legalEntityId: user.legalEntityId,
        branchId: user.branchId,
        actorId: user.id,
        action: decision.result === "locked" ? "auth.login_locked" : "auth.login_failed",
        detail: decision.result === "locked" ? { scope: decision.scope, retryAfter: decision.retryAfter } : {},
      });
    }
    if (decision.result === "locked") return { status: 429 as const, body: lockBody(decision, await branchZone(user, tenantId)) };
    return { status: 401 as const, body: { error: "invalid_credentials" as const } };
  }

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { staffId, password } = parsed.data;
    const tenantId = parsed.data.tenantId ?? DEFAULT_LOGIN_TENANT;

    const user = await findStaffForLogin(db, staffId, tenantId, { anywhere: !parsed.data.tenantId });
    const decision = await judgeSignIn(db, {
      password,
      storedHash: user?.passwordHash ?? null,
      accountKey: accountKeyFor(user?.id, tenantId, staffId),
      ip: clientIp(req),
      eligible: !!user && user.active,
    });
    if (decision.result !== "pass") {
      const refused = await passwordRefusal(user, decision, tenantId);
      return reply.code(refused.status).send(refused.body);
    }
    if (!user) throw new Error("Sign-in passed without a staff user.");
    if (await tenantSuspended(user.tenantId)) return reply.code(403).send({ error: "suspended", detail: "This desk is suspended. Contact CurrencyDesk." });

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
    clearStagingCookie(reply, cookieOpts.secure);
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
  // resolve a staff user by staff id — shared with the platform-admin door
  // so the two cannot drift into two different people. Case folds the same
  // way the failure counter does.
  async function findLoginUser(staffId: string, tenantId: string, anywhere = false) {
    return findStaffForLogin(db, staffId, tenantId, { anywhere });
  }

  /* An owner or a manager clears the account counter. A teller does not.
     There is no device trust here: unlocking does not remember this
     browser, and it does not touch the address counter. */
  const unlockBody = z.object({ staffId: z.string().min(1).max(120) });
  app.post("/api/auth/login/unlock", async (req, reply) => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    if (who.role !== "administrator" && who.role !== "branch_manager") {
      return reply.code(403).send({ error: "forbidden", detail: "Only an owner or a manager can unlock a sign-in." });
    }
    const parsed = unlockBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const target = await findStaffForLogin(db, parsed.data.staffId, who.tenantId);
    if (!target || target.tenantId !== who.tenantId) return reply.code(404).send({ error: "not_found" });
    await clearSignInLock(db, target.id);
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: who.branchId,
      actorId: who.id,
      action: "auth.login_unlocked",
      detail: { staffId: target.staffId },
    });
    return { ok: true };
  });

  // Step 1 of an email-verified sign-in: prove the password, then email a code.
  // Users without an email on file (e.g. seeded staff ids) sign in on the
  // password alone — there's nowhere to send a code.
  app.post("/api/auth/login/start", async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { staffId, password } = parsed.data;
    const tenantId = parsed.data.tenantId ?? DEFAULT_LOGIN_TENANT;
    const user = await findLoginUser(staffId, tenantId, !parsed.data.tenantId);
    const decision = await judgeSignIn(db, {
      password,
      storedHash: user?.passwordHash ?? null,
      accountKey: accountKeyFor(user?.id, tenantId, staffId),
      ip: clientIp(req),
      eligible: !!user && user.active,
    });
    if (decision.result !== "pass") {
      const refused = await passwordRefusal(user, decision, tenantId);
      return reply.code(refused.status).send(refused.body);
    }
    if (!user) throw new Error("Sign-in passed without a staff user.");
    if (await tenantSuspended(user.tenantId)) return reply.code(403).send({ error: "suspended", detail: "This desk is suspended. Contact CurrencyDesk." });
    const recipient = isEmail(user.staffId) ? user.staffId : null;
    if (!recipient) {
      // no address to verify — password is the only factor
      const { token, expiresAt } = await createSession(db, user.id);
      await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
      clearStagingCookie(reply, cookieOpts.secure);
      return { ok: true, needsCode: false, user: await userPayload(user) };
    }
    /* Pressing "Send my code" twice used to send two, and only the second
       one worked — so the code somebody read off the first email was the
       one that failed. The password was already proved above, so refusing
       here tells them nothing they did not know a moment ago. */
    const wait = waitBefore("login:" + user.id);
    if (wait) return reply.code(429).send(tooSoon(wait));

    const code = makeCode();
    const proof = await createLoginProof(db, user.id, hashCode(code));
    /* A staging test owner has no inbox. The same code step still runs.
       The code is in this response only. Live keeps emailing and does
       not receive the code field. */
    const onScreen = await stagingTestOwnerOnScreen(db, req.headers as StagingDoorHeaders, user.staffId, user.tenantId);
    if (!onScreen) {
      const mail = loginCodeEmail(code, user.name);
      const sent = await sendEmail(recipient, mail.subject, { text: mail.text, html: mail.html });
      if (sent === "failed") {
        await deleteLoginProof(db, proof.tokenHash);
        return reply.code(503).send({
          error: "email_unavailable",
          detail: "We couldn't send a sign-in code. Try again in a moment.",
        });
      }
    }
    markSent("login:" + user.id);
    reply.setCookie(LOGIN_PROOF_COOKIE, proof.token, { ...cookieOpts, expires: proof.expiresAt });
    const shown = {
      ok: true as const,
      needsCode: true as const,
      maskedEmail: maskEmail(recipient),
      user: { id: user.staffId, name: user.name, role: user.role, tenantId: user.tenantId, mustChangePassword: user.mustChangePassword },
    };
    if (onScreen) return { ...shown, code };
    return shown;
  });

  /* Step 2. The code is compared only when the password marker is present.
     Without it, an unknown id and a known id take the same path: one dummy
     compare, no staff lookup, the same 401. */
  app.post("/api/auth/login/verify", async (req, reply) => {
    const parsed = verifyLoginBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { staffId, code } = parsed.data;
    codeMatches(code, DUMMY_CODE_HASH);
    const proof = await loadLoginProof(db, req.cookies[LOGIN_PROOF_COOKIE]);
    if (proof.state === "expired") {
      reply.clearCookie(LOGIN_PROOF_COOKIE, cookieOpts);
      return reply.code(410).send({ error: "expired", detail: "That code expired. Sign in again." });
    }
    if (proof.state === "exhausted") {
      reply.clearCookie(LOGIN_PROOF_COOKIE, cookieOpts);
      return reply.code(429).send({ error: "too_many_attempts", detail: "Too many tries. Sign in again." });
    }
    if (proof.state !== "ready") return reply.code(401).send(CODE_REFUSAL);
    const user = (await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, proof.userId)).limit(1))[0];
    if (!user || !user.active || !staffMatches(user, staffId)) return reply.code(401).send(CODE_REFUSAL);
    if (await tenantSuspended(user.tenantId)) return reply.code(403).send({ error: "suspended", detail: "This desk is suspended. Contact CurrencyDesk." });
    if (!codeMatches(code, proof.codeHash)) {
      await noteWrongCode(db, proof.tokenHash, proof.attempts);
      return reply.code(401).send(CODE_REFUSAL);
    }
    await deleteLoginProof(db, proof.tokenHash);
    reply.clearCookie(LOGIN_PROOF_COOKIE, cookieOpts);
    const { token, expiresAt } = await createSession(db, user.id);
    await audit(db, { tenantId: user.tenantId, legalEntityId: user.legalEntityId, branchId: user.branchId, actorId: user.id, action: "auth.login" });
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
    clearStagingCookie(reply, cookieOpts.secure);
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

  /* Taking over the desk is a new sign-in. The screen used to rename
     itself and leave this cookie alone, so the book kept stamping the
     person who had typed the password. The PIN has to be one this
     server stored. 0000 is the old browser fallback and is never a
     yes, even if that is what the hash would have said. */
  app.post("/api/auth/switch", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await resolveSession(db, token);
    if (!who) {
      /* The other switch from this cookie already revoked it. Say so,
         rather than pretending the cookie was never a sign-in. */
      if (token && await sessionIsRevoked(db, token)) {
        return reply.code(409).send({ error: "session_replaced", detail: "This sign-in was already switched." });
      }
      return reply.code(401).send({ error: "unauthenticated" });
    }
    const parsed = switchBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    }
    const { staffId, pin } = parsed.data;
    const matches = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.staffId, staffId));
    const target = matches.find((row) => row.tenantId === who.tenantId);
    /* Same answer for a stranger and for somebody on another desk.
       Which of the two it is must not be readable from the status. */
    if (!target) {
      return reply.code(404).send({ error: "not_found", detail: "That person is not on this desk." });
    }
    if (!target.active) {
      return reply.code(403).send({ error: "inactive", detail: "That account is not active." });
    }
    if (!target.authorizedBranchIds.includes(who.branchId)) {
      return reply.code(403).send({ error: "branch_denied", detail: "That person is not on this branch." });
    }
    const deskName = pinDeskName(target.name);
    const lockedDetail = "Too many wrong tries. This clears on its own in 5 minutes.";
    if (!target.pinHash) {
      return reply.code(409).send({
        error: "no_pin",
        detail: `${deskName} has no PIN yet. They need to choose their own PIN before switching in.`,
      });
    }
    if (target.pinMustChange) {
      return reply.code(409).send({
        error: "must_change",
        detail: `${deskName} needs to choose their own PIN before switching in.`,
      });
    }
    /* 0000 is the old browser fallback. It is refused before the hash is
       read, and it is not a wrong try, so it does not walk the keypad
       toward the lock. A locked keypad still says locked. */
    if (pin === "0000") {
      if (lockState(target.id).locked) {
        return reply.code(429).send({ error: "locked", detail: lockedDetail });
      }
      return reply.code(422).send({
        error: "weak_pin",
        detail: "0000 is too easy to guess. Pick a different PIN.",
      });
    }
    if (!reservePinAttempt(target.id)) {
      return reply.code(429).send({ error: "locked", detail: lockedDetail });
    }
    const pinOk = await verifyPassword(pin, target.pinHash);
    if (!pinOk) {
      const after = lockState(target.id);
      await audit(db, {
        tenantId: target.tenantId, legalEntityId: target.legalEntityId, branchId: target.branchId,
        actorId: who.id, action: "pin.failed", detail: { of: target.staffId, via: "auth.switch" },
      });
      return reply.code(401).send({
        error: "wrong_pin",
        remaining: after.remaining,
        locked: after.locked,
        ...(after.locked ? { detail: lockedDetail } : {}),
      });
    }
    clearPinAttempts(target.id);

    /* Branch membership is not ownership. The session stays on this till
       when they counted it, when nobody has, or when their role is only
       here to look. A teller taking over someone else's count picks a till
       and then counts it. */
    let kept: string | null = null;
    if (who.workspaceId) {
      const workspace = (await db.select({
        id: schema.workspaces.id,
        branchId: schema.workspaces.branchId,
      }).from(schema.workspaces).where(eq(schema.workspaces.id, who.workspaceId)).limit(1))[0];
      if (workspace && target.authorizedBranchIds.includes(workspace.branchId)) {
        const opener = await tillOpener(workspace.id);
        const owns = opener == null || opener === target.id;
        if (owns || TILL_VIEWER.has(target.role)) kept = workspace.id;
      }
    }

    if (!token) return reply.code(401).send({ error: "unauthenticated" });
    let next: { token: string; expiresAt: Date };
    try {
      next = await replaceSession(db, token, target.id, kept);
    } catch (error) {
      if (error instanceof SessionReplacedError) {
        return reply.code(409).send({ error: "session_replaced", detail: "This sign-in was already switched." });
      }
      throw error;
    }
    await audit(db, {
      tenantId: target.tenantId,
      legalEntityId: target.legalEntityId,
      branchId: who.branchId,
      actorId: target.id,
      action: "auth.switch",
      detail: { from: who.id, to: target.id },
    });
    reply.setCookie(SESSION_COOKIE, next.token, { ...cookieOpts, expires: next.expiresAt });
    clearStagingCookie(reply, cookieOpts.secure);
    return {
      ok: true,
      pickTill: kept == null,
      workspaceId: kept,
      user: { id: target.staffId, name: target.name, role: target.role },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await resolveSession(db, token);
    await revokeSession(db, token);
    if (who) {
      await audit(db, { tenantId: who.tenantId, legalEntityId: who.legalEntityId, branchId: who.branchId, actorId: who.id, action: "auth.logout" });
    }
    reply.clearCookie(SESSION_COOKIE, cookieOpts);
    clearStagingCookie(reply, cookieOpts.secure);
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
      return reply.code(403).send({ error: "suspended", detail: "This desk is suspended. Contact CurrencyDesk." });
    }
    const who = resolved.state === "active" ? resolved.user : null;
    if (!who) return reply.code(401).send({ error: "unauthenticated" });
    return {
      /* A label for the banner. It is not a permission. The cookie is
         set only by quick sign-in, and only a staging host may read it. */
      staging: req.cookies[STAGING_COOKIE] === "1" && isStagingRuntime(req.headers.host ?? ""),
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
