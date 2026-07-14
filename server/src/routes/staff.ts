/* ============================================================
   Staff administration — managers run the roster from inside the OS.
     GET    /api/staff                     → roster (no hashes)
     POST   /api/staff                     → create an employee sign-in
     PATCH  /api/staff/:staffId            → name / role / active
     POST   /api/staff/:staffId/password   → reset to a temporary password

   Authorization is role-ranked: branch managers and administrators
   manage the roster; a manager can only touch accounts that rank
   BELOW their own (an administrator can touch other administrators,
   but never themselves — self-service goes through
   /api/auth/change-password, and self-deactivation is refused so a
   desk can't lock itself out). Every action is audited; passwords
   set here are temporary — the employee picks their own at next
   sign-in (must_change_password).
   ============================================================ */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Db } from "../db/index.js";
import { hashPassword } from "../auth/password.js";
import { resolveSession, revokeAllSessions, SESSION_COOKIE, type SessionUser } from "../auth/sessions.js";
import { audit } from "../audit.js";

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

const staffIdShape = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "staff id: letters, digits, . _ -");
const passwordShape = z.string().min(8, "password: at least 8 characters").max(512);
const roleShape = z.enum(["teller", "supervisor", "compliance_officer", "branch_manager", "administrator", "auditor"]);

const createBody = z.object({
  staffId: staffIdShape,
  name: z.string().min(1).max(120),
  role: roleShape,
  password: passwordShape,
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
  name: u.name,
  role: u.role,
  branchId: u.branchId,
  authorizedBranchIds: u.authorizedBranchIds,
  active: u.active,
  mustChangePassword: u.mustChangePassword,
  passwordUpdatedAt: u.passwordUpdatedAt,
  createdAt: u.createdAt,
});

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

    const branchId = b.branchId ?? who.branchId;
    const user = {
      id: `${who.tenantId}:${b.staffId}`,
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      staffId: b.staffId,
      name: b.name,
      role: b.role,
      authorizedBranchIds: b.authorizedBranchIds ?? [branchId],
      passwordHash: await hashPassword(b.password),
      mustChangePassword: true,
      passwordUpdatedAt: new Date(),
    };
    await db.insert(schema.staffUsers).values(user);
    await audit(db, {
      tenantId: who.tenantId,
      legalEntityId: who.legalEntityId,
      branchId,
      actorId: who.id,
      action: "staff.created",
      detail: { staffId: b.staffId, role: b.role, name: b.name },
    });
    const created = await findTarget(who.tenantId, b.staffId);
    return reply.code(201).send({ staff: publicUser(created!) });
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
}
