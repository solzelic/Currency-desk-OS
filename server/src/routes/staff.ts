/* ============================================================
   Staff administration — managers run the roster from inside the OS.
     GET    /api/staff                     → roster (no hashes)
     POST   /api/staff                     → create an employee sign-in
     PATCH  /api/staff/:staffId            → name / role / active
     POST   /api/staff/:staffId/invite     → issue their first sign-in
     POST   /api/staff/:staffId/password   → reset to a temporary password
     POST   /api/staff/:staffId/pin        → issue a new till PIN

   Authorization is role-ranked: branch managers and administrators
   manage the roster; a manager can only touch accounts that rank
   BELOW their own (an administrator can touch other administrators,
   but never themselves — self-service goes through
   /api/auth/change-password, and self-deactivation is refused so a
   desk can't lock itself out). Every action is audited; passwords
   set here are temporary — the employee picks their own at next
   sign-in (must_change_password).

   ADDING SOMEBODY HAS TO GIVE THEM A WAY IN.

   Creating an employee used to demand that the owner invent a
   password and pass it on by hand, which is why the OS's own
   "Add employee" screen never called this route at all — it wrote a
   person into the browser's saved state and nothing else. Meanwhile
   the team named during onboarding was written into `staff_users`
   with an empty password hash and no email: accounts that exist,
   appear on the roster, and cannot be signed into by anybody.

   So: the password is optional here. Leave it out and the server
   issues a temporary one and emails it, or hands it back to be read
   out when the person has no address. Either way the answer says in
   words what their first sign-in is. `canSignIn` on the roster names
   the accounts that still have no credential, so nothing has to be
   inferred from silence.
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword, temporaryPassword } from "../auth/password.js";
import { resolveSession, revokeAllSessions, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { audit } from "../audit.js";
import { sendEmail, type EmailStatus } from "../email.js";
import { clearPinAttempts, generatePin, hashPin } from "./pin.js";

export const ROLE_RANK: Record<SessionUser["role"], number> = {
  teller: 1,
  auditor: 1,
  supervisor: 2,
  compliance_officer: 2,
  branch_manager: 3,
  administrator: 4,
};

const canManage = (actor: SessionUser, targetRole: SessionUser["role"]): boolean => {
  const a = ROLE_RANK[actor.role];
  if (a < ROLE_RANK.branch_manager) return false;
  // admins manage everyone (incl. other admins); managers only ranks below them
  return actor.role === "administrator" || ROLE_RANK[targetRole] < a;
};

/* Two kinds of sign-in name, because the product has always had two: the
   short one a teller types at the counter ("a.singh"), and an email
   address, which is what an owner and anybody hired through onboarding
   uses — and the only kind that can be sent an invitation. The create
   route rejected the second outright, which is part of why the screen that
   collects an employee's email never called it. */
const staffIdShape = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .refine(
    (s) => /^[a-z0-9][a-z0-9._-]*$/i.test(s) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s),
    "staff id: letters, digits, . _ - or an email address",
  );
const passwordShape = z.string().min(8, "password: at least 8 characters").max(512);
const roleShape = z.enum(["teller", "supervisor", "compliance_officer", "branch_manager", "administrator", "auditor"]);

const createBody = z.object({
  staffId: staffIdShape,
  name: z.string().min(1).max(120),
  role: roleShape,
  /* Optional on purpose — see the header. Send one to set it yourself;
     leave it out and the desk issues a temporary one it can actually
     deliver. */
  password: passwordShape.optional(),
  branchId: z.string().min(1).max(120).optional(),
  authorizedBranchIds: z.array(z.string().min(1).max(120)).max(50).optional(),
});

const patchBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    role: roleShape.optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.role !== undefined || b.active !== undefined, { message: "empty patch" });

const resetBody = z.object({ password: passwordShape });

const publicUser = (u: typeof schema.staffUsers.$inferSelect) => ({
  staffId: u.staffId,
  cdId: u.cdId,
  name: u.name,
  role: u.role,
  branchId: u.branchId,
  authorizedBranchIds: u.authorizedBranchIds,
  active: u.active,
  mustChangePassword: u.mustChangePassword,
  passwordUpdatedAt: u.passwordUpdatedAt,
  createdAt: u.createdAt,
  /* Does this person have a credential at all? Onboarding writes the team
     an owner named with an empty hash, and nothing on the roster said so —
     they looked like colleagues who could sign in and were not. Anybody
     false here needs POST /api/staff/:staffId/invite. */
  canSignIn: u.passwordHash !== "",
});

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

/* The desk's own invitation, which is not the platform's password reset.
   "We reset your password at your request" is the wrong sentence to send
   somebody who never had one and did not ask for anything — they were
   hired. Kept short: the thing to do with it is sign in. */
function firstSignInEmail(o: { name: string; deskName: string; signInId: string; tempPassword: string }) {
  const subject = `Your sign-in for ${o.deskName}`;
  const text =
    `${o.name}, you have been added to ${o.deskName} on CurrencyDesk.\n\n` +
    `Sign in as ${o.signInId} with this temporary password: ${o.tempPassword}\n\n` +
    `You will be asked to pick your own password straight away. If you were not expecting this, tell whoever runs the desk.`;
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;color:#0a0a0a">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a8a8a;margin-bottom:18px">CurrencyDesk</div>` +
    `<div style="font-size:15px;line-height:1.6;color:#444">${o.name}, you have been added to <b style="color:#0a0a0a">${o.deskName}</b>. Sign in as <b style="color:#0a0a0a">${o.signInId}</b> with this temporary password:</div>` +
    `<div style="font-family:'Space Mono',ui-monospace,monospace;font-size:26px;font-weight:700;letter-spacing:.12em;margin:20px 0;padding:16px 0;text-align:center;background:#f4f3f0;border-radius:12px">${o.tempPassword}</div>` +
    `<div style="font-size:13px;color:#8a8a8a;line-height:1.6">You will pick your own straight away. If you were not expecting this, tell whoever runs the desk.</div>` +
    `</div>`;
  return { subject, text, html };
}

export interface FirstSignIn {
  staffId: string;
  mustChangePassword: true;
  /* What happened to the credential. "no_address" is somebody who signs in
     as a name rather than an address; "not_sent" is a caller who set the
     password themselves and is passing it on their own way. */
  delivered: EmailStatus | "no_address" | "not_sent";
  sentTo: string | null;
  /* Handed back only when it did not actually reach them — which is every
     desk that has not connected an email provider, and every teller who
     signs in as "a.rostami" and has no address to reach. Withholding it
     there would mean creating an account nobody can use, which is the bug
     this route was written to end. */
  tempPassword?: string;
  detail: string;
}

/* Get a temporary password to the person it belongs to, and tell the
   caller in words what their first sign-in is. Says nothing about how the
   password was stored — the two callers differ there. */
async function deliverSignIn(
  user: Pick<typeof schema.staffUsers.$inferSelect, "staffId" | "cdId" | "name">,
  deskName: string,
  temp: string,
): Promise<FirstSignIn> {
  const signInId = user.cdId || user.staffId;
  if (!isEmail(user.staffId)) {
    return {
      staffId: user.staffId,
      mustChangePassword: true,
      delivered: "no_address",
      sentTo: null,
      tempPassword: temp,
      detail: `${user.name} signs in as ${signInId} and has no email address, so there is nowhere to send this. Read it to them — they pick their own password on the way in.`,
    };
  }

  const mail = firstSignInEmail({ name: user.name, deskName, signInId, tempPassword: temp });
  const delivered = await sendEmail(user.staffId, mail.subject, { text: mail.text, html: mail.html }).catch(() => "failed" as const);
  return {
    staffId: user.staffId,
    mustChangePassword: true,
    delivered,
    sentTo: user.staffId,
    ...(delivered === "sent" ? {} : { tempPassword: temp }),
    detail:
      delivered === "sent"
        ? `Sent to ${user.staffId}. They sign in as ${signInId} and pick their own password straight away.`
        : delivered === "simulated"
          ? `Email is not connected on this deployment, so nothing was sent. Give them this password yourself — they sign in as ${signInId} and pick their own straight away.`
          : `The email to ${user.staffId} did not go. Give them this password yourself, or try again once mail is working.`,
  };
}

/* Issue a first sign-in to somebody who already exists: a fresh temporary
   password, every device they were holding signed out, and the password on
   its way to them. Re-issuing is what happens when the first one went
   astray, so the old one has to die with it. */
async function issueFirstSignIn(
  db: Db,
  user: typeof schema.staffUsers.$inferSelect,
  deskName: string,
): Promise<FirstSignIn> {
  const temp = temporaryPassword();
  await db
    .update(schema.staffUsers)
    .set({ passwordHash: await hashPassword(temp), mustChangePassword: true, passwordUpdatedAt: new Date() })
    .where(eq(schema.staffUsers.id, user.id));
  await revokeAllSessions(db, user.id);
  return deliverSignIn(user, deskName, temp);
}

export function registerStaffRoutes(app: FastifyInstance, db: Db) {
  // every route here needs an authenticated manager+ session
  const requireManager = async (req: { cookies: Record<string, string | undefined> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<SessionUser | null> => {
    const who = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    if (!who) {
      reply.code(401).send({ error: "unauthenticated" });
      return null;
    }
    if (ROLE_RANK[who.role] < ROLE_RANK.branch_manager) {
      reply.code(403).send({ error: "forbidden" });
      return null;
    }
    return who;
  };

  const findTarget = async (tenantId: string, staffId: string) => {
    const rows = await db
      .select()
      .from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, tenantId), eq(schema.staffUsers.staffId, staffId)))
      .limit(1);
    return rows[0];
  };

  app.get("/api/staff", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const rows = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.tenantId, who.tenantId));
    return { staff: rows.map(publicUser) };
  });

  app.post("/api/staff", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const b = parsed.data;
    if (!canManage(who, b.role)) return reply.code(403).send({ error: "role_exceeds_yours" });

    const existing = await findTarget(who.tenantId, b.staffId);
    if (existing) return reply.code(409).send({ error: "staff_id_taken" });
    /* An address identifies a person across the whole product — it is how
       sign-in resolves which desk they belong to without being told. The
       same one at two desks makes that ambiguous, and the person ends up
       signing in to whichever desk the lookup happened to pick. */
    if (isEmail(b.staffId)) {
      const elsewhere = (await db.select({ tenantId: schema.staffUsers.tenantId }).from(schema.staffUsers).where(eq(schema.staffUsers.staffId, b.staffId)).limit(1))[0];
      if (elsewhere) return reply.code(409).send({ error: "email_in_use", detail: "That email already signs in to a CurrencyDesk desk." });
    }

    const branchId = b.branchId ?? who.branchId;
    /* A person belongs to a location, and putting them at one that does not
       exist used to reach the database as a foreign-key violation and come
       back as a 500. It matters more now that locations can be created:
       the screen adds Scarborough and then adds somebody to it. */
    const branch = (await db
      .select({ id: schema.branches.id })
      .from(schema.branches)
      .where(and(eq(schema.branches.tenantId, who.tenantId), eq(schema.branches.id, branchId)))
      .limit(1))[0];
    if (!branch) return reply.code(400).send({ error: "no_such_branch", detail: "That location is not on this desk." });
    const authorized = b.authorizedBranchIds ?? [branchId];
    const known = new Set((await db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.tenantId, who.tenantId))).map((r) => r.id));
    const unknown = authorized.filter((id) => !known.has(id));
    if (unknown.length) return reply.code(400).send({ error: "no_such_branch", detail: `Not a location on this desk: ${unknown[0]}` });

    /* The credential exists before the row does. Creating the person first
       and setting a password afterwards leaves an account nobody can reach
       if anything in between fails — which is precisely the state
       onboarding leaves behind and this route exists to stop. */
    const temp = b.password ?? temporaryPassword();
    await db.insert(schema.staffUsers).values({
      id: `${who.tenantId}:${b.staffId}`,
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      staffId: b.staffId,
      name: b.name,
      role: b.role,
      authorizedBranchIds: authorized,
      passwordHash: await hashPassword(temp),
      mustChangePassword: true,
      passwordUpdatedAt: new Date(),
    });

    const desk = (await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1))[0];
    const person = { staffId: b.staffId, cdId: null, name: b.name };
    const signIn: FirstSignIn = b.password
      ? {
          staffId: b.staffId,
          mustChangePassword: true,
          delivered: "not_sent",
          sentTo: null,
          detail: `You set their password. ${b.name} signs in as ${b.staffId} and picks their own straight away.`,
        }
      : await deliverSignIn(person, desk?.name ?? "your desk", temp);

    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      actorId: who.id,
      action: "staff.created",
      detail: { staffId: b.staffId, role: b.role, name: b.name, branchId, invited: !b.password, delivered: signIn.delivered },
    });
    const fresh = await findTarget(who.tenantId, b.staffId);
    return reply.code(201).send({ staff: publicUser(fresh!), signIn });
  });

  /* Their first way in, for somebody who has none — or a second one,
     because the first went to an inbox they never opened.

     The team an owner lists during onboarding lands in `staff_users` with
     no password and no email, so until this existed those people were on
     the roster and could not sign in, and nothing anywhere said why. This
     is the route that answers it. */
  app.post("/api/staff/:staffId/invite", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const { staffId } = req.params as { staffId: string };
    const target = await findTarget(who.tenantId, staffId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!canManage(who, target.role)) return reply.code(403).send({ error: "role_exceeds_yours" });
    // your own credential changes via /api/auth/change-password, which asks
    // for the current one — this route would sign you out of your own desk
    if (target.id === who.id) return reply.code(403).send({ error: "use_change_password" });
    if (!target.active) return reply.code(409).send({ error: "inactive", detail: "That account is blocked. Turn it back on first." });

    const desk = (await db.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, who.tenantId)).limit(1))[0];
    const had = target.passwordHash !== "";
    const signIn = await issueFirstSignIn(db, target, desk?.name ?? "your desk");
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: target.branchId,
      actorId: who.id,
      action: had ? "staff.invite_reissued" : "staff.invited",
      detail: { staffId: target.staffId, delivered: signIn.delivered },
    });
    return { ok: true, signIn };
  });

  app.patch("/api/staff/:staffId", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { staffId } = req.params as { staffId: string };
    const target = await findTarget(who.tenantId, staffId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!canManage(who, target.role)) return reply.code(403).send({ error: "role_exceeds_yours" });
    const b = parsed.data;
    if (b.role && !canManage(who, b.role)) return reply.code(403).send({ error: "role_exceeds_yours" });
    // no self-sabotage: you can't deactivate or demote your own account
    if (target.id === who.id && (b.active === false || (b.role && b.role !== target.role))) {
      return reply.code(403).send({ error: "cannot_modify_own_access" });
    }

    const changes: Record<string, unknown> = {};
    if (b.name !== undefined && b.name !== target.name) changes.name = b.name;
    if (b.role !== undefined && b.role !== target.role) changes.role = b.role;
    if (b.active !== undefined && b.active !== target.active) changes.active = b.active;
    if (Object.keys(changes).length > 0) {
      await db.update(schema.staffUsers).set(changes).where(eq(schema.staffUsers.id, target.id));
      if (changes.active === false) await revokeAllSessions(db, target.id);
      await audit(db, {
        tenantId: who.tenantId,
        legalEntityId: who.legalEntityId,
        branchId: target.branchId,
        actorId: who.id,
        action: changes.active === false ? "staff.deactivated" : changes.active === true ? "staff.reactivated" : "staff.updated",
        detail: { staffId: target.staffId, changes },
      });
    }
    const fresh = await findTarget(who.tenantId, staffId);
    return { staff: publicUser(fresh!) };
  });

  app.post("/api/staff/:staffId/password", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const parsed = resetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message });
    const { staffId } = req.params as { staffId: string };
    const target = await findTarget(who.tenantId, staffId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!canManage(who, target.role)) return reply.code(403).send({ error: "role_exceeds_yours" });
    // your own password changes via /api/auth/change-password (needs the current one)
    if (target.id === who.id) return reply.code(403).send({ error: "use_change_password" });

    await db
      .update(schema.staffUsers)
      .set({ passwordHash: await hashPassword(parsed.data.password), mustChangePassword: true, passwordUpdatedAt: new Date() })
      .where(eq(schema.staffUsers.id, target.id));
    await revokeAllSessions(db, target.id);
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: target.branchId,
      actorId: who.id,
      action: "staff.password_reset",
      detail: { staffId: target.staffId },
    });
    return { ok: true, mustChangePassword: true };
  });

  /* A teller who has forgotten their till PIN, or leaned on the keypad until
     it shut, is standing at the counter with a customer. The owner fixes that
     here rather than ringing support: a fresh PIN, read out once. It is
     returned in the clear because that is the only way it reaches somebody
     who has no email — it is never stored that way, and never readable
     again. Resetting also clears the lockout, which is the point. */
  app.post("/api/staff/:staffId/pin", async (req, reply) => {
    const who = await requireManager(req, reply);
    if (!who) return;
    const { staffId } = req.params as { staffId: string };
    const target = await findTarget(who.tenantId, staffId);
    if (!target) return reply.code(404).send({ error: "not_found" });
    if (!canManage(who, target.role)) return reply.code(403).send({ error: "role_exceeds_yours" });
    // your own PIN changes via /api/staff/pin, which asks for the current one
    if (target.id === who.id) return reply.code(403).send({ error: "use_set_pin" });

    const pin = generatePin();
    await db.update(schema.staffUsers).set({ pinHash: await hashPin(pin), pinSetAt: new Date(), pinMustChange: true }).where(eq(schema.staffUsers.id, target.id));
    clearPinAttempts(target.id);
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId: target.branchId,
      actorId: who.id,
      action: "staff.pin_reset",
      detail: { staffId: target.staffId },
    });
    return { ok: true, pin };
  });
}
